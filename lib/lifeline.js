/**
 * dsh-mind · 月度生命索引（monthly lifeline）
 *
 * CCG 六要素:
 *   功能名   把日记按月压成「一句话摘要」，作为常驻时间骨架注入
 *   生效条件 config.lifeline.enabled && 有新月的日记可归纳（或索引缺失）
 *   子功能   月归纳（本地模板，不调模型）/ 常驻索引渲染 / 按语义展开相关月份 / index 文件原子读写
 *   执行     rebuild(store) · renderIndex() · pickRelevant(text) · readIndex()
 *   验证方式 tests/regress.mjs 第 90 组（月归纳、边界、幂等、预算、展开、无日记不炸）
 *   不适用条件 需要「理解语义再概括」（那要模型；本模块只做确定性归纳）
 *
 * ⚠️ 为什么需要它（2026-11-16，读 VCP 白皮书 §9.5 后加的）：
 *   dsh-mind 现在的时间记忆是**两级**：
 *     ① 压缩前日记（一篇，只在压缩后注入一次，2000 字符）
 *     ② 存档原文（按 seq 存，要用 mind_expand 主动取）
 *   中间**断了一档**：一年前的经历既不在日记里（日记只留最新一篇），
 *   也不能靠 mind_search 想到去搜（不知道有什么可搜）。
 *   这正是 VCP 白皮书那条「你不记得的东西，怎么知道要去回忆它」。
 *
 *   它的解法的核心不在公式，而在**成本结构**：
 *   「全部月份一句话摘要常驻，按当前语义展开相关月份」。
 *   白皮书给的口径：五年约 60 条月度节点 ≈ 800 Token。
 *   这里照这个结构做，但**归纳方式换成确定性模板**（见下），不引入模型调用。
 *
 * ⚠️ 为什么不调模型来归纳（关键取舍）：
 *   VCP 用模型写月摘要。本插件不在注入热路径上做 LLM 调用 ——
 *   pre-step 里等一次模型往返，会把主人的每一次输入都拖慢。
 *   而且模型归纳**不可复现**：同样的日记重跑一次得到不同摘要，
 *   于是「索引变没变」无法用指纹判断，会退化成每步全量重算。
 *   所以这里只用**确定性模板**：月份、天数、条目数、出现最多的人名/路径/关键词。
 *   信息密度低于模型摘要，但它可复现、零延迟、零成本，且**不会编造**。
 *
 * ⚠️ 与星汐（dsh-xingxi）的关系（必须写清，避免重复造）：
 *   星汐有「日记/YYYY-MM-DD.md」+「记忆卡.md」，是**按天**写的档案，
 *   它靠 `xingxi_read` 按日期检索，**不常驻注入**（见 dsh-xingxi/index.js 的
 *   「全部档案有五六万 token，不可能每次全塞进上下文」）。
 *   本模块补的不是日记本身，而是「**月的索引常驻**」这一层：
 *   让模型不用先想到去查日期，就知道「2026-09 那个月我在做什么」。
 *   两者不重叠：星汐存事实，这里存时间骨架。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MIND_DIR, atomicWriteJson, readJson, shortId, oneLine } from './io.js'

export const LIFELINE_PATH = () => join(MIND_DIR(), 'lifeline.json')

/** 单个索引文件里最多保留几个月（防御性上限，正常 5 年也才 60 个）。 */
export const MAX_MONTHS = 240

/** 常驻索引的默认字符上限。约 60 个月 × 每条 ~60 字符 ≈ 3600，够五年。 */
export const DEFAULT_INDEX_CHARS = 3600

/**
 * 日记目录：沿用 diary.js 的 `MIND_DIR()/diary`。
 *
 * ⚠️ 不 import diary.js 的 DIARY_DIR —— 那是它的内部常量（未 export）。
 *   但路径必须**同源**，否则本模块会去读一个空目录然后永远报「无日记」。
 *   所以这里按同一规则拼（MIND_DIR()/diary），
 *   并在 tests/regress.mjs 里有一条判据专门比对两处路径一致。
 */
export function DIARY_DIR() {
  return join(MIND_DIR(), 'diary')
}

// ─────────────────────── 归 纳（确定性，无模型） ───────────────────────

/**
 * 主题词的**篇数**门槛（不是次数）。
 *
 * ⚠️ 为什么按"出现在几篇"而不是"出现几次"（2026-11-16 第四轮定）：
 *   按次数算时，一篇日记里同一段模板句重复三遍就能把一个碎片顶上门槛；
 *   而按篇数算，碎片必须在**不同上下文**里反复出现才算数 ——
 *   这正是"词"与"句子碎片"最本质的区别，而且不需要分词器。
 *
 *   门槛 2：至少两篇不同的日记都提到它。
 *   一个只在一篇日记里出现的词，本来就只属于那一天，不该进月索引。
 *
 * ⚠️ 必须放在**模块级**而不是 signalsOf 内部：
 *   summarizeMonth 也要用它，而被嵌在函数里的定义外面看不见
 *   （2026-11-16 首次跑就抛 ReferenceError，被这一条抓出来）。
 */
export function topicDocThreshold() {
  return 2
}

/**
 * 从日记正文里挑出「属于这个月、属于我自己」的段落，丢掉模板段与别人说的话。
 *
 * ⚠️ 2026-11-16 真机第五轮修的根因（前四轮都在治标）：
 *   按篇计数后跑真实数据，主题词变成了
 *   「按预期生效、不过它有四个、不能凭感觉关、不能只看文件」——
 *   全是**别的窗口的发言**。
 *
 *   原因在日记结构里（见 diary.js 的 composeDiary）：
 *     · `## 给压缩后的自己` —— 每篇一字不差的模板
 *     · `## 别的窗口在忙什么` —— **别的会话**的原话，却复制进本会话每一篇日记
 *   后者的内容在 19 篇日记里几乎逐字重复，所以"跨篇出现"这个判据
 *   被它完美满足 —— 判据没错，是**输入喂错了**。
 *
 *   这正好是本机 AGENTS.md 记过的那个坑的翻版：
 *   「timeline 是共享层，混着所有窗口的发言」→ 日记里读了别窗口的话，
 *   把**别的窗口的任务**当成本窗口的语境。
 *   当时修的是 ④/⑤ 分节，但**行数分开了、词还是混在一起统计**。
 *   现在在取词这一步就把它们分开。
 */
function ownSections(text) {
  const t = String(text ?? '')
  const lines = t.split(/\r?\n/)
  const kept = []
  let cur = null
  const DROP = new Set(['给压缩后的自己', '别的窗口在忙什么（不是本窗口的事）', '别的窗口在忙什么'])

  for (const ln of lines) {
    const h = /^##\s+(.+)$/.exec(ln)
    if (h) {
      cur = h[1].trim()
      continue // 标题本身不进正文（标题名在 heads 里已单独收集）
    }
    // 没有章节标记时（第三方日记、手写日记）→ 整篇都要
    if (cur === null) {
      kept.push(ln)
      continue
    }
    if (DROP.has(cur)) continue
    kept.push(ln)
  }
  return cur === null && kept.length === 0 ? t : kept.join('\n')
}

/**
 * 从一段日记里抽出「追求声明」—— mind_intend 写下的那几句。
 *
 * ⚠️ 2026-11-16 第五轮定下的**主路径**（前面几轮做词频统计，都是这条的退路）：
 *   没有中文分词器时，从自由正文里抽"词"必然切出跨词边界的碎片 ——
 *   实测出现「被执行策略禁」「并做出宣传视」这种。
 *   再怎么调规则都是在拟合，没有出路。
 *
 *   但日记里本来就有一段**人写的、语义完整的短句**：
 *   `## 我在追什么（mind_intend 的未结声明）` 下面每条 `- [id] 主线：…`。
 *   那是 mind_intend 登记的，天生就是"这个月在做什么"。
 *
 *   所以月主题**优先取它**，词频只作为没有追求声明时的退路。
 *   代价是：一个月没调用 mind_intend 就没有主题 ——
 *   但"没有"远好过"错的"，索引里塞进碎片会让整层失去可信度。
 */
export function pursuitsOf(text) {
  const t = String(text ?? '')
  const m = /##\s*我在追什么[^\n]*\n([\s\S]*?)(?=\n##\s|$)/.exec(t)
  if (!m) return []
  return (m[1].match(/^-\s*\[[^\]]*\]\s*(.+)$/gm) ?? [])
    .map((l) => l.replace(/^-\s*\[[^\]]*\]\s*/, '').trim())
    .filter((s) => s.length >= 4)
}

/**
 * 从一段日记正文里提取「值得进月索引」的信号。
 *
 * ⚠️ 判据必须是**可复现的字符串规则**，不能用语义判断：
 *   同一天日记重跑必须得到同一结果，否则指纹每次都变 → 每步全量重算。
 *
 * 取四类信号，各自有理由：
 *   ① 路径（E:\… / C:\… / /x/）：主人最常问「那个文件在哪」，路径是最硬的锚点
 *   ② 引号里的原话：主人纠正与确认过的话，价值最高（呼应 compaction.js 的逐字引用要求）
 *   ③ 中文实词串：用来概括「这个月主题」，取出现频次高的
 *   ④ 条目标题（`## ` / `# `）：日记里本来就分了节，标题本身就是摘要
 */
export function signalsOf(text) {
  const full = String(text ?? '')
  // ⚠️ 取词只用**本窗口自己的段落**（见 ownSections 的注释）。
  //   路径与引号仍从全文取 —— 它们是具体锚点，"别的窗口提到的路径"
  //   对本月的定位反而有参考价值，且不会像实词那样重复到把判据骗过。
  const t = ownSections(full)
  const body = t
    .replace(/^#.*$/gm, (m) => '\n' + m.trim() + '\n') // 标题留一行，参与 ④
    .replace(/\s+/g, ' ')

  // ⚠️ 2026-11-22 修：模板段里固定含 ~/.dsh/AGENTS.md 与「上次是这样」「主人心情不好」「未结线索」，
  //   旧实现从 full 抽引号导致所有月份的 quotes 100% 被模板占满。
  //   现在引号只从本窗口正文 t（ownSections）提取，路径也剔除模板固定路径。
  const paths = [...new Set(full.match(/(?:[A-Za-z]:\\[^\s"'）)，。；]+|\/(?:Users|home|tmp)\/[^\s"'）)，。；]+)/g) ?? [])]
    .filter((p) => p.length >= 6 && !/[\\/]AGENTS\.md$/i.test(p))
    .slice(0, 4)

  // 引号里的原话：只从剥离模板后的正文 t 提取，剔除日记模板固定示例句
  const TEMPLATE_QUOTES = new Set(['「上次是这样」', '「主人心情不好」', '「未结线索」', '「别的窗口在忙」'])
  const quotes = [...new Set(t.match(/[「“"]([^「」“”"\n]{4,60})[」”"]/g) ?? [])]
    .filter((q) => !TEMPLATE_QUOTES.has(q))
    .slice(0, 3)

  // 条目标题（## xxx / # xxx）
  const heads = [...new Set((t.match(/^#{1,3}\s+(.+)$/gm) ?? []).map((h) => h.replace(/^#+\s*/, '').trim()))]
    .filter((h) => h.length >= 2 && h.length <= 40)
    .slice(0, 5)

  // 中文实词：2~6 字的高频片段，去掉明显是模板的固定句
  //
  // ⚠️ 2026-11-16 真机实测两轮才定下来（两轮都是被真实数据打脸）：
  //
  //   第一轮：不过滤 → 主题词出来「取代、助手、主人」。
  //     全是日记模板里的固定措辞（"被 X 取代"、"[助手]"、"[主人]"），零信息量。
  //
  //   第二轮：只加 NOISE 名单 + "含虚词就丢" → 主题词**全空**。
  //     实测本机 19 篇日记 37291 字，词频前 45 名里除了模板句，
  //     剩下的正好都带虚词（"运行环境"带"运"没问题，但"配置项已经看"这种才是多数）。
  //     规则太严，把有信息量的也杀了。
  //
  //   现在这一版的判据（对着上面的真实词频表定的）：
  //     ① 整句模板 → 丢（NOISE）
  //     ② 以虚词/代词/动词收尾 → 丢（"配置项已经看"、"清了"、"手写的"）
  //     ③ **不**因含有任意虚词就丢 —— "运行环境""跨会话""根因"这类必须留下
  //   判据越具体越可测；"像不像名词"这种语义判断本模块不做。
  const NOISE = new Set([
    // 模板小标题
    '压缩前日记', '给压缩后的自己', '给压缩后的自', '女仆在被压缩', '前亲手写的', '手写的',
    '已作废的结论', '别再用', '未结线索', '别的窗口在忙', '不是本窗口的', '本窗口',
    '我在追什么', '的未结声明', '压缩前最后几句对话', '这条因预算被截断',
    // 固定整句
    '本文为准', '冲突时以本文', '冲突时以本文为准', '需要时重读', '人格与纪律在',
    '交付前绑定本', '轮实测输出', '压缩会遮蔽它', '根因未定位', '不影响',
    '上次是这样', '不算证据', '应该', '因为', '什么',
    // 角色标签
    '助手', '主人', '女仆',
    // 泛化动词（单独出现没有信息量，但它们和别的词组成短语时会留下）
    '取代', '作废', '收到', '结论',
  ])

  /**
   * 判一个片段是不是"像模样的主题词"。
   *
   * ⚠️ 2026-11-16 反复调了四轮才定，每轮都是被真实输出打脸。教训本身值得留在代码里：
   *
   *   轮1 不过滤 → 「取代、助手、主人」（模板词，零信息量）
   *   轮2 加噪声表 + 含虚词就丢 → 全空（把"运行环境"也杀了）
   *   轮3 只拦收尾 → 「磁盘阵列的事、今天继续处理、进度还行」（句子碎片）
   *   轮4 含"的/事/继续"就丢 → 又全空
   *
   *   **根因不是规则松紧，是切词方式错了**：
   *   正则 `[\u4e00-\u9fa5]{2,6}` 是贪婪最长匹配，没有分词器就必然切出
   *   "处理磁盘阵列" / "的事情" 这种**跨词边界**的碎片。
   *   无论把规则调松调紧，都只是在"放进噪声"和"杀掉真词"之间来回摆。
   *
   *   所以真正的判据换成**跨篇稳定性**（见 summarizeMonth）：
   *   一个片段如果在**多篇不同的日记**里都完整出现，它才可能是词；
   *   只在单篇里出现的片段无法与"句子碎片"区分，一律不采用。
   *   这条判据不需要分词器、可复现、可测，而且它的错法只有"漏掉"不会"编造"。
   */
  function looksLikeTopic(w) {
    if (NOISE.has(w)) return false
    // 收尾是虚词 / 助词 / 动词 → 句子碎片
    if (/[的了是在和被抓对被把将就都也还又更最很太没不无]$/.test(w)) return false
    if (/[看说做写来去会想要把给到后前时]$/.test(w)) return false
    // 以连接词 / 时间副词开头的是半个句子
    if (/^(已经|还是|就是|不是|可以|应该|因为|所以|而且|然后|今天|明天|昨天)/.test(w)) return false
    return true
  }

  const freq = new Map()
  for (const m of t.match(/[\u4e00-\u9fa5]{2,6}/g) ?? []) {
    if (!looksLikeTopic(m)) continue
    freq.set(m, (freq.get(m) ?? 0) + 1)
  }
  // ⚠️ 这里**不设门槛**（2026-11-16 第四轮定）。
  //   本函数只负责"从一段文字里抽出候选片段"，至于某个片段算不算主题词，
  //   必须由 sum 在**整篇/整月**的尺度上判断（见 summarizeMonth 的 perDoc）。
  //   门槛放在这里就会出现前面那个坑：单篇里够不着门槛 → 永远选不出词。
  //   返回按频次排序的候选（带次数），让调用方自己决定门槛。
  const words = [...freq.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 40)
    .map(([w]) => w)

  return { paths, quotes, heads, words, chars: t.length, body }
}

/** 从文件名里取日期：兼容 `xxx-2026-11-12T06-23-38.md` 与 `2026-11-12.md`。 */
export function dateOfFile(name) {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(String(name ?? ''))
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

/**
 * 把一组日记（同一个月）归纳成一句话 + 结构化要点。
 *
 * @param {string} ym 'YYYY-MM'
 * @param {Array<{date:string, text:string, file:string}>} items
 * @returns {{ym:string, days:number, chars:number, headline:string, points:string[], paths:string[], quotes:string[]}}
 */
export function summarizeMonth(ym, items) {
  const days = new Set()
  let chars = 0
  const parts = []

  for (const it of items) {
    days.add(it.date)
    const txt = String(it.text ?? '')
    chars += txt.length
    parts.push(txt)
  }

  // ⚠️ 2026-11-16 真机修的关键一步：**跨篇统计，而不是单篇累加**。
  //
  //   轮1 的写法是逐篇调 signalsOf 再把 words 累加 —— 频次门槛按单篇算，
  //   而单篇日记只有 1600 字符左右，同一个词一天内不可能出现 3 次 → words 恒为空，
  //   月索引只剩「节：…」半句，**没有任何报错**。
  //
  //   轮2 改成把整月拼起来统计一次：次数够了，但把"磁盘阵列的事"这种
  //   跨词边界碎片也顶了上来（没有分词器，贪婪匹配必然切歪）。
  //
  //   现在这一版是**按篇计数**：一个片段出现在几篇**不同的日记**里。
  //   这是"词"与"句子碎片"最本质的差别，而且不需要分词器：
  //     · 真词（运行环境 / 跨会话）→ 会横跨多天出现
  //     · 句子碎片（…的事 / 今天继续处理）→ 通常只在它被写下的那天出现
  const perDoc = new Map() // word -> 出现过它的篇数
  const allPursuits = []
  const allPaths = new Set()
  const allQuotes = new Set()
  const heads = new Map()
  // 单次遍历每篇日记，同时采集词频、追求、路径、引号与章节标题（避免重复调用两遍 signalsOf）
  for (const it of items) {
    const s = signalsOf(it.text)
    for (const w of new Set(s.words)) perDoc.set(w, (perDoc.get(w) ?? 0) + 1)
    for (const p of pursuitsOf(it.text)) allPursuits.push(p)
    for (const p of s.paths) allPaths.add(p)
    for (const q of s.quotes) allQuotes.add(q)
    for (const h of s.heads) heads.set(h, (heads.get(h) ?? 0) + 1)
  }

  /**
   * 月主题：**优先**用 mind_intend 登记的追求句。
   *
   * ⚠️ 为什么追求句优先（2026-11-16 第五轮定，见 pursuitsOf 的注释）：
   *   自由正文抽词在没有分词器时必然切出碎片（实测「被执行策略禁」）。
   *   而追求句是人写的完整短句，天生就是这个月在做什么。
   *   两者不是"更好的 vs 更差的"，是"能用的 vs 不稳定的"。
   *
   * 去重：同一件事会被多次声明（更新进展），这里按句子的前 12 字近似去重，
   * 保留**最新**那条（最后出现的），因为它含最新进展。
   */
  /**
   * 追求句要压缩成「短主题」，不能原样塞进常驻索引。
   *
   * ⚠️ 2026-11-16 实测看到的实际问题：
   *   原样塞进去之后 headline 变成
   *   「在做：主线：重建运行环境（<workspace>\venv）。根因已更正（先前「qrcode_term…」
   *   一条就 100+ 字符，两个月就能把 1300 预算撑爆，而且读起来完全不像索引。
   *
   *   压缩规则（确定性，不调模型）：
   *     ① 去掉「主线：」「当前在做的：」这类前缀标签
   *     ② 只取到第一个句号/分号为止 —— 第一句通常就是主题，后面是进展细节
   *     ③ 硬上限 28 字符（够放"重建 bili 运行环境"这种）
   *   宁可短到只剩一个名词短语，也不要长到读不下去。
   */
  function shortenPursuit(p) {
    let s = String(p ?? '').trim()
    s = s.replace(/^(主线|副线|当前在做的|当前进展|目标)[:：]\s*/, '')
    const cut = s.split(/[。；;\n]/)[0]
    if (cut) s = cut
    s = s.replace(/（[^）]*）/g, '').replace(/\([^)]*\)/g, '') // 去掉括号里的路径/补充
    s = s.trim()
    return s.length > 28 ? s.slice(0, 27) + '…' : s
  }

  const seen = new Map()
  for (const p of allPursuits) {
    const short = shortenPursuit(p)
    if (!short || short.length < 4) continue
    const key = short.slice(0, 10)
    seen.set(key, short) // 后面的覆盖前面的 = 保留最新
  }
  const pursuitThemes = [...seen.values()].slice(-3)

  // 退路：没有追求声明时才用词频（并明确标注来源，避免读者以为那是总结）
  const topWords = [...perDoc.entries()]
    .filter(([, n]) => n >= topicDocThreshold())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([w]) => w)

  const topHeads = [...heads.entries()]
    // ⚠️ 2026-11-16 真机看到的噪声：「压缩前日记 · 2026-11-05 07:19:08 UTC」
    //   这是 diary.js 落在每篇开头的**文档标题**，每篇都有、只是时间不同。
    //   它既不是章节也不是主题，进 headline 只是白占字符。
    .filter(([h]) => !/^压缩前日记/.test(h) && !/\d{4}-\d{2}-\d{2}T/.test(h))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 3)
    .map(([h]) => h)

  const dayList = [...days].sort()
  const span =
    dayList.length === 1
      ? dayList[0].slice(8) + ' 日'
      : `${dayList[0].slice(8)}~${dayList[dayList.length - 1].slice(8)} 日`

  // headline 是**这一句常驻**，必须短且有信息量。
  //
  // ⚠️ 变量名不能叫 parts —— 上面已经有一个 parts（拼起来用于统计的正文数组）。
  //   2026-11-16 重名过一次：headline 的 parts 会把正文数组覆盖掉，
  //   于是"主题"永远算不出来且不报错。这类同名覆盖是静默失败的高发地。
  const headlineBits = []
  headlineBits.push(`${ym}（${days.size} 天 / ${Math.round(chars / 1000)}k 字，${span}）`)
  // ⚠️ 来源必须标出来：追求句是**人写的声明**，词频是**机器猜的候选**。
  //   两者可信度差很远，混在一起读者会以为都是总结过的结论。
  if (pursuitThemes.length) headlineBits.push(`在做：${pursuitThemes.join('；')}`)
  else if (topWords.length) headlineBits.push(`线索词：${topWords.join('、')}`)
  if (topHeads.length) headlineBits.push(`节：${topHeads.join(' / ')}`)
  const headline = headlineBits.join(' · ')

  return {
    ym,
    days: days.size,
    chars,
    headline,
    points: pursuitThemes.length ? pursuitThemes : topWords,
    // ⚠️ 来源必须显式标出来，别让下游（pickRelevant / expandMonth）把
    //   机器候选词当成"人写的主题"用。
    themeSource: pursuitThemes.length ? 'pursuit' : topWords.length ? 'word' : 'none',
    paths: [...allPaths].slice(0, 4),
    quotes: [...allQuotes].slice(0, 3),
    firstDate: dayList[0] ?? null,
    lastDate: dayList[dayList.length - 1] ?? null,
  }
}

// ─────────────────────── 索 引 读 写 ───────────────────────

/**
 * 读索引文件。
 *
 * ⚠️ 与 io.js 的 readJson 一样：文件坏/缺都返回空结构，**不抛**。
 *   索引是"锦上添花"，它坏了不能带崩注入（注入带崩会拖垮主人对话）。
 */
let indexCache = { path: '', statKey: '', data: null }

export function readIndex() {
  const file = LIFELINE_PATH()
  let statKey = 'missing'
  try {
    if (existsSync(file)) {
      const st = statSync(file)
      statKey = `${st.mtimeMs}:${st.size}`
    }
  } catch {
    statKey = 'err'
  }
  if (indexCache.data && indexCache.path === file && indexCache.statKey === statKey) {
    return indexCache.data
  }
  const raw = readJson(file, null)
  const data =
    !raw || typeof raw !== 'object' || !Array.isArray(raw.months)
      ? { version: 1, months: [], builtAt: null }
      : {
          version: 1,
          months: raw.months.filter((m) => m && typeof m.ym === 'string'),
          builtAt: raw.builtAt ?? null,
        }
  indexCache = { path: file, statKey, data }
  return data
}

/**
 * 扫日记目录，按月份分组后归纳，写回索引。
 *
 * @param {object} [opts]
 * @param {string} [opts.sessionId] 只归纳某会话的日记（省略则归纳全部）
 * @returns {{ok:boolean, months:number, scanned:number, added:number, updated:number, error?:string}}
 */
export function rebuild({ sessionId = null } = {}) {
  const dir = DIARY_DIR()
  let names = []
  try {
    if (!existsSync(dir)) return { ok: true, months: 0, scanned: 0, added: 0, updated: 0, empty: true }
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch (e) {
    return { ok: false, months: 0, scanned: 0, added: 0, updated: 0, error: String(e?.message ?? e) }
  }

  // 只取指定会话的日记：diary.js 的文件名是 `<shortId>-YYYY-MM-DDTHH-mm-ss.md`
  if (sessionId) {
    const prefix = shortId(sessionId, 12).replace(/…$/, '')
    names = names.filter((n) => n.startsWith(prefix))
  }

  const byMonth = new Map()
  let scanned = 0
  for (const n of names) {
    const date = dateOfFile(n)
    if (!date) continue
    const p = join(dir, n)
    let text = ''
    try {
      // ⚠️ 大文件保护：单篇日记正常 2~5 KB，超过 512 KB 说明写坏了，
      //   不读全文（否则一次归纳把内存吃光）。
      if (statSync(p).size > 512 * 1024) continue
      text = readFileSync(p, 'utf8')
    } catch {
      continue
    }
    scanned++
    const ym = date.slice(0, 7)
    if (!byMonth.has(ym)) byMonth.set(ym, [])
    byMonth.get(ym).push({ date, text, file: p })
  }

  const old = readIndex()
  const oldByYm = new Map(old.months.map((m) => [m.ym, m]))
  const months = []
  let added = 0
  let updated = 0
  /**
   * 本次扫描覆盖到的月份：只有这些月份的旧节点允许被"更新"。
   *
   * ⚠️ 2026-11-17 修（隔离实测：真实日记轮转到第 7 篇后，十月节点消失）。
   *
   * 原来的语义是"只按当前日记目录重建索引"。而日记每个会话只留 6 篇
   * （diary.js 的 DIARY_MAX_PER_SESSION），长会话跨月时旧月份的**最后一篇日记
   * 会被正常清理策略删掉** → 该月再也扫不到 → 重建时该月节点凭空消失。
   * 于是"多年时间骨架"这个设计目标在长会话上根本不成立。
   *
   * 现在改成**累积语义**：扫到的月份用新结果覆盖，扫不到的月份
   * **保留上一次索引里的节点**。日记被轮转清理不等于那个月没发生过。
   *
   * 反例：❌ 只信当前目录 —— 滚动清理会一寸寸吃掉历史。
   */
  const scannedYm = new Set()

  for (const [ym, items] of byMonth) {
    // 同一天写了多篇（压缩多次）→ 合并的那一天只留最长的一篇参与归纳，
    // 但天数按去重算（summarizeMonth 里用 Set 已经处理了）
    const s = summarizeMonth(ym, items)
    const prev = oldByYm.get(ym)
    if (!prev) added++
    else if (prev.headline !== s.headline) updated++
    scannedYm.add(ym)
    months.push(s)
  }

  // 把"这次扫描没覆盖到、但历史上存在"的月份节点补回来。
  let preserved = 0
  for (const [ym, m] of oldByYm) {
    if (scannedYm.has(ym)) continue
    months.push(m)
    preserved++
  }

  months.sort((a, b) => a.ym.localeCompare(b.ym))
  const kept = months.slice(-MAX_MONTHS)

  try {
    mkdirSync(MIND_DIR(), { recursive: true })
    const payload = {
      version: 1,
      months: kept,
      builtAt: new Date().toISOString(),
    }
    atomicWriteJson(LIFELINE_PATH(), payload)
    indexCache = { path: '', statKey: '', data: null }
  } catch (e) {
    return { ok: false, months: kept.length, scanned, added, updated, error: String(e?.message ?? e) }
  }

  return { ok: true, months: kept.length, scanned, added, updated, preserved }
}

// ─────────────────────── 渲 染 ───────────────────────

/**
 * 把索引渲染成给模型看的**一句话时间骨架**。
 *
 * ⚠️ 为什么只给一句话不给要点：常驻的东西**必须便宜**。
 *   要点（路径、引号）放进去会立刻膨胀十倍，而那部分该在"展开"时才给。
 *   常驻只负责回答「有哪些月份、各是什么主题」，够模型决定"要不要展开"。
 *
 * @param {number} maxChars 上限；超出时**保留最近**的月份（越近越可能相关）
 */
export function renderIndex(maxChars = DEFAULT_INDEX_CHARS) {
  const { months } = readIndex()
  if (!months.length) return ''

  const lines = []
  // 从最近往前加，超预算就停（近的优先，远的可有可无）
  for (let i = months.length - 1; i >= 0; i--) {
    const m = months[i]
    const line = `- ${m.headline}`
    const more = m.paths.length ? `｜${m.paths[0]}` : ''
    // ⚠️ 只在还有余量时才带路径（路径是最长的部分，但它最有用）
    const cand = lines.length === 0 || lines.join('\n').length + line.length + more.length < maxChars * 0.75
      ? line + more
      : line
    if (lines.join('\n').length + cand.length + 1 > maxChars) break
    lines.unshift(cand)
  }
  if (!lines.length) return ''

  const spanned = months.length > lines.length ? `（共 ${months.length} 个月，下面只列最近的 ${lines.length} 个）` : `（共 ${months.length} 个月）`
  return `### 月份索引${spanned}\n${lines.join('\n')}\n\n- 想看某个月的具体经历：\`mind_lifeline {ym:"YYYY-MM"}\``
}

/**
 * 索引是否到了该重建的时候（2026-11-16 体检 A1 修）。
 *
 * ⚠️ 血证：config.lifeline.rebuildEveryMs 从上线起就是**死配置** ——
 *   index.js 的注释承诺「距上次建超过 rebuildEveryMs → 重建」，
 *   但实现只有「渲染为空才 rebuild」，全库没有任何地方消费这个键。
 *   后果：索引建一次后**永不更新**，新写的日记静默进不了月索引。
 *
 * ⚠️ 判断放在这里而不是 index.js：读 builtAt 要 readIndex()，
 *   那是本模块的地盘；index.js 只该问「要不要重建」，不该自己翻索引文件。
 *
 * @param {number} everyMs 重建间隔；<=0 或非数字视为「每次注入都重建」（保守：宁可多扫不可陈旧）
 * @param {number} now
 * @returns {{due:boolean, reason:string, ageMs?:number}}
 */
export function rebuildDue(everyMs, now = Date.now()) {
  const { builtAt } = readIndex()
  if (!builtAt) return { due: true, reason: 'no-builtAt' }
  const at = Date.parse(builtAt)
  if (!Number.isFinite(at)) return { due: true, reason: 'bad-builtAt' }
  const ageMs = now - at
  const every = Number(everyMs)
  if (!Number.isFinite(every) || every <= 0) return { due: true, reason: 'no-interval', ageMs }
  return ageMs >= every ? { due: true, reason: 'aged', ageMs } : { due: false, reason: 'fresh', ageMs }
}

/**
 * 按当前语境挑出相关的月份（用于"要不要展开"的提示，不展开正文）。
 *
 * ⚠️ 判据是**确定性字符匹配**，不是语义检索：
 *   语境里出现"那件事的名词/路径"才命中。这条能覆盖「主人提到某个项目名」
 *   这种最高频的真实场景，而不会像向量检索那样给出无法解释的相似。
 */
export function pickRelevant(text, limit = 2) {
  const q = String(text ?? '')
  if (!q.trim()) return []
  const { months } = readIndex()
  const scored = []
  for (const m of months) {
    let score = 0
    for (const w of m.points ?? []) if (w && q.includes(w)) score += 3
    for (const p of m.paths ?? []) {
      // 路径只比末段，避免全盘匹配
      const tail = p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')
      if (tail && q.includes(tail)) score += 4
    }
    for (const qt of m.quotes ?? []) {
      const inner = String(qt).replace(/^[「“"]|[」”"]$/g, '')
      if (inner.length >= 4 && q.includes(inner)) score += 2
    }
    if (score > 0) scored.push({ ym: m.ym, score, headline: m.headline })
  }
  scored.sort((a, b) => b.score - a.score || b.ym.localeCompare(a.ym))
  return scored.slice(0, limit)
}

/**
 * 展开某个月的完整要点（供 mind_lifeline 工具用）。
 *
 * ⚠️ 这里是"按需展开"那一半：常驻只给 headline，
 *   真正要细节时把路径、引号、节标题一起拿出来。
 */
export function expandMonth(ym) {
  const key = String(ym ?? '').trim()
  const { months } = readIndex()
  const m = months.find((x) => x.ym === key)
  if (!m) {
    return {
      ok: false,
      error: `索引里没有 ${key}。可用：${months.map((x) => x.ym).join(', ') || '（还没有任何月份）'}`,
    }
  }
  return { ok: true, month: m, points: m.points ?? [], paths: m.paths ?? [], quotes: m.quotes ?? [], notes: oneLine(m.headline, 200) }
}
