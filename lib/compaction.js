/**
 * dsh-mind · 自己的压缩引擎
 *
 * CCG 六要素:
 *   功能名   接管上下文压缩的摘要环节，用自己的指令与自己的语言写检查点
 *   生效条件 cordis.patch.yml 里**替换** compaction-basic 条目
 *   子功能   继承 BasicCompactionEngine（官方唯一钩子 summarize()）/ 中文八段结构 / 保留人格与反例
 *   执行     MindCompactionEngine.apply(ctx, config)
 *   验证方式 重启后日志出现「mind-compaction READY」，且压缩产物是中文
 *   不适用条件 需要改压缩的触发阈值或保留策略（那些走 compaction-basic 的配置，本类不动）
 *
 * ⚠️ 为什么要接管（2026-11-05 主人指定）：
 *   原先后端用硬编码的 COMPACTION_INSTRUCTION：强制英文、八个英文小节、
 *   且明写「Do NOT mention this summarization request」。
 *   于是压缩后的女仆读到的是**一份英文的、别人写的、并被告知不要提起的转述**。
 *   更糟的是 `AGENTS.md` 是 user/message，压缩会整个遮蔽它 ——
 *   人格 6000 字节被压成摘要里的几行 bullet。这就是"身份被外包"。
 *
 * ⚠️ 为什么继承而不是重写：
 *   `summarize()` 是官方文档写明的**唯一子类钩子**。压力判定、区间选择、
 *   表层替换、锁、溢出恢复全部由基类负责 —— 那些是最容易写错、错了最危险的部分。
 *   我们只换"摘要怎么写"，不碰"何时压、压哪段、怎么落地"。
 *
 * ⚠️ 为什么这个文件是**独立入口**而不是塞进 lib/index.js：
 *   它要 import @deepseek-ai/dsh-compaction-basic。万一宿主版本变了、
 *   包解析失败，只需要让压缩退回基本后端，**不能连带把记忆注入拖垮**。
 *   分成两个 entry，一个坏一个活。
 */

import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import { BlockAssembler, LlmError, contentHasImage } from '@deepseek-ai/dsh-llm'
import { archiveRegion, archiveIndexText } from './archive.js'
import { inferShadowedSeqs } from './infer-region.js'
import { log, STATE_PATH } from './io.js'
import { maybeWriteDiary } from './diary.js'
import { readConfig } from './config.js'
import { readPeerGlobal } from './peer.js'
import { existsSync, readFileSync } from 'node:fs'

export const name = 'dsh-mind-compaction'
export const inject = ['llm', 'tokenMeter', 'sessions']

/**
 * 自己的压缩指令。
 *
 * 与原版（英文八段）的差别，逐条都说清理由：
 *   ① 中文输出 —— 主人 2026-11-01 指定「全程用中文思考与汇报」，摘要也是女仆的记忆
 *   ② 保留「已作废的结论」一节 —— 原版没有。这是最危险的一类信息：
 *      过时的根因会被后一个模型当作现况使用，然后一路错下去
 *   ③ 保留「还没做完的事」与「下一步」—— 原版有 Pending Jobs / Next Step，保留
 *   ④ 允许写原文引语 —— 主人纠正女仆的话必须逐字留，转述会丢语气与限定条件
 *   ⑤ 去掉「不要提起被压缩」—— 这条让压缩后的女仆在不知情下把转述当亲身经历。
 *      改成明确告知：这是检查点，不是你的原话。
 *   ⑥ 第一人称（2026-11-12 主人选 B 档后改）：原来是「你现在是这个 AI 助手的
 *      上下文压缩器……让另一个模型继续工作」——**把女仆的身份外包给了第三方**。
 *      改后是「你就是这个助手本人，给自己写交接便条」。差别不只在人称：
 *      第三人称视角会天然写成"它做了什么"的流水账，第一人称才会写"我为什么这么做"。
 *      配套加了证据分级（已验证/记不清/推断未验证），三种不许混写。
 *
 * ⚠️ 为什么**不是**换个专用摘要模型（主人 2026-11-12 选 B 时女仆核对过）：
 *   换模型只改"谁来执行摘要"，不改"以什么身份写"。第三方小模型写第一人称
 *   反而更容易写出"我"开头的流水账而没有真正的自我连续性。真正的修法是指令本身。
 */
const MIND_COMPACTION_INSTRUCTION = `你就是上面这段对话里的那个助手本人（主人称你为「女仆」，你称用户为「主人」）。现在请你把上面这段对话**压缩成一份写给自己的交接便条**——等一下的你将只带着这张便条继续干活，而这段原文会被遮蔽。

这不是「给第三方写摘要」，是**你自己给未来的自己留字条**。所以：
- 全程用**第一人称**（「我」「女仆」）。禁止出现「助手如何」「该模型如何」「它做了什么」这类旁观者措辞——那会让压缩后的我把别人的描述当成自己的记忆。
- 写你**真正需要记住**的东西，不是把对话复述一遍。
- 不要为了让便条好看而省略难看的部分：失败、被推翻、没查完、被主人纠正，恰恰是最该留的。

严格按下面的 Markdown 结构输出，每一节都要保留、顺序不变。用简洁的短句列表，不要写成散文。某一节为空就写「（无）」，绝不允许删掉整节。

## 最初与当前的意图
- 主人最开始要什么、后来怎么变的；**关键措辞要逐字引用**，尤其是纠正与否定

## 技术背景
- 在用的技术、框架、约定、本机环境事实（路径、版本号、绝对路径要原样保留）

## 文件与代码
- 精确路径：为什么重要、改了什么、关键片段

## 踩过的坑与修法
- 错误现象：根因是什么、怎么解决的、主人对此说过什么

## 已作废的结论
- 哪些曾经认为对的判断**已被推翻**，被什么取代。这一节极其重要：过时的根因会被后来的模型当成现况

## 还没做完的事
- 明确被要求但尚未完成的工作

## 未完成与待验证（**这一节专记"没做成什么"**）
- **计划过但还没执行**的动作（哪怕只在心里想过）
- **试过但失败**的方向，连同失败的具体原因
- **尚未验证**的假设、猜对了但没确认的结论
- 明确排除掉的选项，以及为什么排除

> 为什么单独拎出来（2026-11-10 依据 Anthropic 长任务上下文工程 + 微软 RE-TRAC）：
> 失败的轨迹里绝大多数不是"不会做"，而是**中途计划过某个分支、被后续信息淹没、
> 最后没查完就交了答案**。只记"做过什么"救不回这类失败，必须记"**没做什么**"。
> 上面「还没做完的事」记的是**任务层**的待办；这一节记的是**思考层**的悬空项，两者不重复。

## 压缩时正在做什么
- 精确认到中断那一刻的进度

## 下一步
- 紧接着该做的**单个**动作；没有就写「（无）」

## 必须记住的上下文
- 决策及其理由、硬约束、主人的偏好、未解的疑问、继续工作必需的数据

规则：
- 用中文写。文件路径、命令、报错原文、标识符、数值、函数签名、语法片段一律保留原样，不要翻译。
- **全篇第一人称**。任何一处写成「助手/该模型/它」都算违规，必须改成「我」或「女仆」。
- 主人说过的话要忠实记录，特别是**纠正**——那是最高价值的信息。**逐字引用**的必须放进引号，不许改写成你的转述。
- **证据分级**（这是本便条最重要的质量要求）：
  - 写「已验证 / 已确认」之前，必须能指出**具体的工具输出或文件行号**；
  - 只记得「大概是这样」的，写「⚠️ 记不清，需重查」；
  - 你**推断**出来、但从没实际验证过的，写「⚠️ 女仆的推断，未验证」；
  - 三者不许混写，不许把推断写成已验证。
- 如果上面已经存在 <compacted-summary> 块，那是**更早的便条**，也是**你自己以前写的**：不要照抄，保留仍然成立的事实，丢掉已过时的，把新信息合并进同一份结构。若旧便条里写「已验证」而你这一步看到了反证，**以新证据为准**，并明确写上「旧结论作废」。
- 只输出便条正文，不要调用任何工具，不要执行任何动作。

**输出开头必须先写下面这一段（原样保留，不要改写、不要省略）：**
> 📝 这是**我自己**在上下文压缩前写的交接便条，不是逐字记录，是**有损**的。
> 它可能记错、可能过时——**如果眼前的证据和它冲突，一律以你眼前的证据为准**，
> 不要被自己以前写的东西带偏；任务没解决时，要主动扩大搜索范围，而不是照着旧路线再走一遍。
> 这份便条**可以被推翻**：它只是线索，不是事实。
> （依据 2026-11-10 调研：模型会过度依赖上一轮总结而卡在错误路径上，
> 明确授予"怀疑权"后准确率反而更高。所以这份便条明确授予未来的我怀疑权。）
`

/**
 * 从内容块里取纯文本；有图片就按原版约定失败（不静默丢内容）。
 */
function summaryText(blocks) {
  if (contentHasImage(blocks)) {
    throw new LlmError('mind 压缩摘要不接受图片输出', 'UNSUPPORTED_CONTENT')
  }
  return blocks.filter((b) => b?.type === 'text')
}

/** 把终止分片的失败映射成错误，与基类同样的语义。 */
function finishError(finish) {
  switch (finish?.kind) {
    case 'error':
    case 'aborted':
      return new LlmError(finish.failure?.message ?? '压缩摘要失败', finish.failure?.code, finish.failure)
    case 'max-tokens': {
      const e = new Error('压缩摘要撞到输出上限（检查点不完整）')
      e.code = 'MAX_TOKENS'
      return e
    }
    default:
      return undefined
  }
}

/**
 * 本次进程里已经落过盘的区间（`sessionId:首-尾:条数`）。
 *
 * 为什么需要：`summarizeCompaction` 失败后会 `recover` 再
 * `prepareCompaction` 重试同一区间，`summarize()` 会被**再次调用**。
 * 没有这道闸门就会把同一个 1 MB 的区间反复重写。
 */
const ARCHIVED_KEYS = new Set()

/**
 * 压缩**已经确定发生**时，强写一篇日记。
 *
 * ⚠️ 为什么需要这条路（2026-11-05 第二次修，主人指定）：
 *   日记原本只由 `agent/pre-step` 里「压力 ≥ 70%」触发。
 *   但真机实测：主人四次压缩全部是手打 `/compact`
 *   （会话日志 `command/run name="compact" source={"kind":"user"}` 四条），
 *   手动压缩时压力只有 30~45%，**永远够不到 70%**。
 *   结果 `mind/diary/` 目录从建起到现在**一次都没被创建过**。
 *
 *   而 `summarize()` 是压缩确定发生时的唯一可靠信号 ——
 *   在这里强写，不需要猜压力，也不需要赌 listener 顺序。
 *
 * ⚠️ 绝不能抛：日记是附带功能，写不出来也不能影响压缩本身。
 *   压缩失败比少一篇日记严重得多。
 *
 * @returns {string|null} 日记路径，没写返回 null
 */
function forceDiaryOnCompaction(ctx, agent) {
  try {
    const sessionId = agent?.session?.id
    if (!sessionId) {
      log('压缩日记跳过 :: 拿不到 sessionId')
      return null
    }

    let config
    try {
      config = readConfig()
    } catch (e) {
      log(`压缩日记跳过 :: 读配置失败 ${e?.message ?? e}`)
      return null
    }
    if (config?.diary?.enabled === false) return null

    // ⚠️ 2026-11-08 拆分：facts / timeline 现在住在 dsh-strand。
    //   走 peer 软依赖读取（只读对方的 JSON 文件，不 import 模块）。
    //   读不到就传空数组 —— 日记少两节，但日记本身照写。
    //   **绝不能因此让压缩失败**：压缩失败比少两节日记严重得多。
    let g = { facts: [], timeline: [], threads: [], available: false }
    try {
      g = readPeerGlobal()
      if (!g.available) {
        log(`压缩日记：对端共享层不可用（原因 ${g.reason ?? 'unknown'}），日记里这两节留空`)
      }
    } catch (e) {
      log(`压缩日记：对端共享层读取异常（降级为空） :: ${e?.message ?? e}`)
    }

    // ⚠️ 2026-11-09 补：pursuits 在本插件的 state.json 里（不在 peer）。
    //   压缩强写是日记最重要的路径，这一段更不能缺。
    //   直接读落盘快照而不 import Store：这里只要数据，不要它的写盘行为；
    //   读不到就空数组，日记少一节但压缩绝不失败。
    let pursuits = []
    try {
      const p = STATE_PATH()
      if (existsSync(p)) {
        const st = JSON.parse(readFileSync(p, 'utf8'))
        if (Array.isArray(st?.pursuits)) pursuits = st.pursuits.filter((x) => x && !x.closedAt)
      }
    } catch {
      /* 降级：少一节，不影响压缩 */
    }

    // ⚠️ 传真正的 ctx：本引擎 `inject` 里有 `tokenMeter`（见文件头第 37 行），
    //   所以这里能拿到计量服务。第一版误传了 `{tokenMeter: undefined}`，
    //   结果强制写也会在 `getMeter()` 那一步返回 null —— 等于没改。
    return maybeWriteDiary(ctx, {
      sessionId,
      agent,
      facts: g.facts,
      timeline: g.timeline,
      others: [],
      pursuits,
      config,
      force: true,
    })
  } catch (e) {
    log(`压缩日记异常（已降级跳过） :: ${e?.name ?? 'Error'}: ${e?.message ?? e}`)
    return null
  }
}

/**
 * 摘要**之前**把被折叠的原文落盘。
 *
 * ⚠️ 为什么必须在调 LLM 之前（2026-11-05 第二次修，主人指定）：
 *   第一版把存档放在 `summarize()` 的**末尾**（拿到摘要之后）。
 *   于是「摘要失败 ⇒ 原文也没存」——两次压缩的 1019 条原文就是这么丢的：
 *   第一次是反推坏了，第二次是同样的路径。规律很清楚：
 *   **把存档挂在成功路径的尾巴上，失败路径就什么都不留。**
 *
 *   现在存档提到最前面：哪怕模型超时、返回空、撞 max-tokens、
 *   甚至整个压缩最终失败，**原文仍然已经躺在磁盘上**。
 *
 * ⚠️ 为什么不干脆放在基类里：`summarize()` 是唯一子类钩子，
 *   基类不给"压缩开始前"的回调。而在 summarize 开头落盘，
 *   时间点与"压缩已确定要发生"是同一个 —— 区间也已由基类选定。
 *
 * ⚠️ 失败仍然不影响压缩：所有异常就地吞掉并留痕。
 */
function archiveShadowedRegion(agent, input) {
  const session = agent?.session
  if (!session) {
    log('压缩存档跳过 :: 拿不到 session')
    return null
  }

  let inferred
  try {
    inferred = inferShadowedSeqs(session, input)
  } catch (e) {
    log(`压缩存档异常 :: 反推抛错 ${e?.message ?? e}`)
    return null
  }
  if (!inferred) {
    log('压缩存档跳过 :: 反推 seq 区间失败（宁可不存也不存错区间）')
    return null
  }
  const seqs = inferred.seqs
  if (seqs.length === 0) {
    log('压缩存档跳过 :: 反推区间为空')
    return null
  }

  const key = `${session.id}:${seqs[0]}-${seqs.at(-1)}:${seqs.length}`
  if (ARCHIVED_KEYS.has(key)) {
    log('压缩存档跳过 :: 本区间已落盘（重试路径，不重复写）')
    return null
  }

  try {
    const r = archiveRegion({
      sessionId: session.id,
      seqs,
      eventAt: (s) => session.eventAt(s),
    })
    if (r === null) {
      log(
        `压缩存档失败 :: 区间 ${seqs[0]}..${seqs.at(-1)}（${seqs.length} 个 seq）落盘返回 null`,
      )
      return null
    }
    ARCHIVED_KEYS.add(key)
    log(
      `压缩存档完成 :: seq ${r.startSeq}..${r.endSeq} ` +
        `${r.entries} 条 ${Math.round(r.bytes / 1024)} KB` +
        `${r.truncated ? '（已截断）' : ''} :: ${r.path}`,
    )
    return r
  } catch (e) {
    log(`压缩存档异常 :: ${e?.message ?? e}`)
    return null
  }
}

// 反推 seq 区间的逻辑抽到 infer-region.js —— 那里不 import 任何宿主包，可直接测。
export class MindCompactionEngine extends BasicCompactionEngine {
  /**
   * 覆盖唯一钩子：摘要怎么写。
   *
   * ⚠️ 这里刻意**照抄基类的调用骨架**（replay 前缀 → 追加一条指令 → 流式收集 → 包成 user 消息）。
   *   不这么做的后果：丢掉了"复用提供方热前缀"这个性质，每次压缩都全量重发，
   *   成本翻几倍。所以结构不能改，只改指令文本与后处理。
   */
  async summarize(input, agent, signal) {
    const config = this.config
    const latest = agent?.session?.requestHeader?.()?.config
    const configured =
      config.summarizationProvider && config.summarizationProvider.length > 0
        ? { provider: config.summarizationProvider, model: config.summarizationModel }
        : undefined
    const agentTarget =
      agent?.options?.provider && agent?.options?.model
        ? { provider: agent.options.provider, model: agent.options.model }
        : undefined
    const target = configured ?? latest ?? agentTarget

    if (!target) {
      throw new Error(
        'mind 压缩：没有可用的 provider/model —— 配置 summarizationProvider/Model，或先发一次请求',
      )
    }

    const assembler = new BlockAssembler()

    // ── 可逆：把被折叠的原文落盘（2026-11-05 第二次修）──
    //
    // ⚠️⚠️ 位置是本轮的关键改动：**在调 LLM 之前**。
    //   第一版放在末尾（拿到摘要之后），于是「摘要失败 ⇒ 原文也没存」。
    //   血证：某个真实会话前两次压缩的 1019 条原文就是这么丢的。
    //   现在模型超时／返回空／撞 max-tokens／整个压缩失败，原文都已落盘。
    const archived = archiveShadowedRegion(agent, input)

    // ── 压缩前日记：压缩已确定发生，强写一篇（2026-11-05 第二次修）──
    //
    // ⚠️ 位置在 LLM 调用之前，与存档同一个时刻。
    //   理由和存档完全一样：**挂在成功路径的尾巴上，失败路径就什么都不留。**
    //   摘要失败时，日记反而更有价值 —— 那时连检查点都没有，只剩这篇日记。
    const diaryPath = forceDiaryOnCompaction(this.ctx, agent)

    const messages = [
      ...input.messages,
      { role: 'user', content: [{ type: 'text', text: MIND_COMPACTION_INSTRUCTION }] },
    ]

    const options = {
      provider: target.provider,
      model: target.model,
      messages,
      toolHistory: agent.session.toolHistory(),
      ...(input.tools === undefined ? {} : { tools: [...input.tools] }),
      maxTokens: config.maxTokens,
      sessionId: agent.session.id,
      purpose: 'compaction',
      ...(signal === undefined ? {} : { signal }),
    }

    for await (const chunk of this.ctx.llm.stream(options)) assembler.push(chunk)

    const err = finishError(assembler.finish)
    if (err) throw err

    const rawOutput = assembler.blocks()
    const summary = summaryText(rawOutput)
    if (!summary.some((b) => b.text.trim().length > 0)) {
      throw new Error('mind 压缩：模型没产出任何文本摘要')
    }

    // 摘要末尾附上「已折叠区间」索引，让压缩后的自己知道哪儿能取回原文。
    // 没有存档就不加（不占常驻预算）。
    let summaryBlocks = summary
    let indexAdded = false
    try {
      const idx = archiveIndexText(agent?.session?.id)
      if (idx) {
        const merged = summary
          .filter((b) => b?.type === 'text')
          .map((b) => b.text)
          .join('\n\n')
        summaryBlocks = [{ type: 'text', text: `${merged}\n\n---\n\n${idx}` }]
        indexAdded = true
      }
    } catch (e) {
      summaryBlocks = summary
      log(`压缩索引附加失败 :: ${e?.message ?? e}`)
    }
    log(`压缩摘要就绪 :: 正文 ${summary.map((b) => b.text).join('').length} 字符，存档索引 ${indexAdded ? '已附上' : '未附上'}`)

    return {
      summary: summaryBlocks,
      rawOutput,
      llmStreamCall: true,
      provider: options.provider,
      model: options.model,
      maxTokens: config.maxTokens,
      ...(assembler.usage === undefined ? {} : { usage: assembler.usage }),
      ...(archived === null ? {} : { mindArchive: archived }),
      ...(diaryPath === null ? {} : { mindDiary: diaryPath }),
    }
  }
}

export default MindCompactionEngine

