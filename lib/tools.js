/**
 * dsh-mind · 工具定义
 *
 * CCG 六要素:
 *   功能名   mind_* 工具：自我觉知 + 压缩相关
 *   生效条件 config.tools && tools 服务就绪（延迟重试注册）
 *   子功能   mind_intend（声明追求）· mind_view（看全貌）· mind_windows（列窗口）
 *            · mind_status（排查）· mind_expand（取回原文）· mind_search（搜存档）
 *            · mind_compress（主动压缩）
 *   执行     execute() 返回结构化对象；render() 转成文本给模型看
 *   验证方式 tests/regress.mjs 工具组（注册、schema、execute 返回形状）
 *   不适用条件 需要在工具里做长时间任务（工具应快速返回）
 *
 * ⚠️ 2026-11-08 拆分：四个跨会话工具已搬到 dsh-strand，改成 `strand_` 前缀：
 *   mind_remember → strand_remember
 *   mind_recall   → strand_recall
 *   mind_forget   → strand_forget
 *   mind_keys     → strand_keys
 *   本文件不再 import global.js —— 它已经不在这里了。
 *   剩下的 7 个工具分两类：**自我觉知**（intend / view / windows / status）
 *   与**压缩**（expand / search / compress）。前者回答"我是谁、我在哪"，
 *   后者回答"被折掉的东西去哪了"。
 *
 * ⚠️ 为什么 psyche_intend 必须存在（主体连续的关键）：
 *   只有能**主动声明**「我在追什么」，这个插件才不是监控面板而是表达器官。
 *   没有它，所谓"主体连续"就是一堆被动采集的字段。
 */

import { log as ioLog } from './io.js'
import { listArchives, expandRegion, searchArchives } from './archive.js'
import { shortId, agoText, MIND_DIR, GLOBAL_PATH, LOG_PATH, EXPERIENCE_DIR } from './io.js'
import * as PsycheSegment from './segments/psyche.js'
import * as Proactive from './proactive.js'
import { readPeerGlobal, PEER_GLOBAL_PATH } from './peer.js'

const ok = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]

export function makeToolDefinitions(store, { config, log = ioLog, CLI_PATH }) {
  const common = {
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, additionalProperties: true },
      render: (_args, value) => ok(value),
    },
  }

  return [
    // ── 意图自述 ──
    {
      name: 'mind_intend',
      description:
        '声明「你此刻在追什么」。这是跨窗口共享的意图，别的窗口能看到它在推进什么。' +
        '接一个跨多轮的任务时、中途改变目标时、卡住时说明卡在哪，都该调它。' +
        '不要用它记录琐碎动作（那些会被自动采集）。' +
        '传 {close} 表示这件事已完成或放弃。',
      parameters: {
        text: {
          type: 'string',
          description: '一句话说清在追什么，建议含目标与当前进展。',
        },
        close: {
          type: 'string',
          description: '可选。给一条已有的追求文本或 id，表示这件事已经完成/放弃。',
        },
      },
      ...common,
      async execute(args, execCtx) {
        const id = execCtx?.agent?.id ?? execCtx?.agent?.session?.id ?? null
        if (args?.close) {
          const closed = store.closePursuit(args.close)
          return closed
            ? { ok: true, closed: { id: closed.id, text: closed.text } }
            : { ok: false, error: '没找到对应的未结追求（可能已关闭，或关键字不匹配）' }
        }
        const text = String(args?.text ?? '').trim()
        if (!text) return { ok: false, error: 'text 不能为空' }
        const res = store.addPursuit(text, id)
        store.snapshot()
        log(`intend :: ${shortId(id, 6)} :: ${text.slice(0, 60)}${res?._updated ? ' (更新已有)' : ''}`)
        return {
          ok: true,
          // ⚠️ `updated=true` 表示这句话被识别为「同一件事的最新进展」，
          //   原地更新了已有条目（没有新增一条）。要让主人/模型都知道这件事，
          //   否则它会以为"我刚才是不是又说了一遍"，看不出更新生效了。
          updated: res?._updated === true,
          pursuit: { id: res?.id, text: res?.text },
          openCount: store.openPursuits().length,
        }
      },
    },

    // ── 看全貌 ──
    {
      name: 'mind_view',
      description:
        '看自己此刻的完整状态：注意力分散在哪几处、每处在做什么、在追什么。' +
        '用于「我刚才在别的窗口干什么了」「还有几处醒着」这类需要全貌的时刻。平时不必调 —— ' +
        '状态变化会自动注入。',
      parameters: {
        verbose: { type: 'boolean', description: '为 true 时列出所有登记过的窗口（含已不再醒着的）。' },
      },
      ...common,
      async execute(args) {
        const now = Date.now()
        const live = store.liveWindows(now)
        const all = [...store.windows.values()]
        const pick = args?.verbose === true ? all : live
        return {
          ok: true,
          now: new Date(now).toISOString(),
          identity: store.identity,
          liveCount: live.length,
          registeredCount: all.length,
          windows: pick.map((w) => ({
            id: w.id,
            short: shortId(w.id, 6),
            alive: w.aliveUntil > now,
            thinking: !!w.thinking,
            activity: w.activity ? { tool: w.activity.tool, text: w.activity.text, ago: agoText(w.activity.at, now) } : null,
            intent: w.intent ? { text: w.intent.text, ago: agoText(w.intent.at, now) } : null,
            lastUser: w.lastUserText ?? null,
            lastUserAgo: w.lastUserAt ? agoText(w.lastUserAt, now) : null,
            turns: w.turns ?? 0,
          })),
          pursuits: store.openPursuits().map((p) => ({ id: p.id, text: p.text, ago: agoText(p.at, now) })),
        }
      },
    },

    // ── 排查 ──
    //
    // ⚠️ 2026-11-06 修：描述里写着「最近注入情况」，但 execute 根本没实现 ——
    //   这不是文案小毛病，是最坏的一种：**工具承诺了它不做的事**。
    //   主人问「记忆好像没生效」时的第一个动作就是调它，
    //   而旧实现只回开关和预算，答不了「到底注进去了没有、多久前注定」。
    //   现在真的从 store 里读每个窗口的 injectedAt（recordInjected 早就在写），
    //   并给出人话的「多久以前」；从没注入过的窗口显式标 never。
    {
      name: 'mind_status',
      description:
        '排查「记忆好像没生效」：三段各自的开关与**最近注入情况**、预算、配置来源、数据目录。' +
        '一个工具看完三处，不必分别翻日志。',
      parameters: {
        verbose: { type: 'boolean', description: '为 true 时附上完整配置与路径。' },
      },
      ...common,
      async execute(args) {
        const now = Date.now()
        const live = store.liveWindows(now)
        // 已登记窗口里「最近一次被注入」是什么时候（含已不在线但还留着的）
        const injected = [...store.windows.values()]
          .filter((w) => w.injectedAt)
          .sort((a, b) => String(b.injectedAt).localeCompare(String(a.injectedAt)))
          .slice(0, 10)
          .map((w) => ({
            short: shortId(w.id, 6),
            alive: (w.aliveUntil ?? 0) > now,
            at: w.injectedAt,
            ago: agoText(w.injectedAt, now),
          }))
        // ⚠️ 内存里的 window.injectedAt **重启后是空的**（windows 不落盘）。
        //   只靠它会让这个排查工具在每次重启后都误报"从未注入过" ——
        //   排查工具骗人比没有更糟。所以再取一份跨重启保留的 lastInject。
        const lastInject = store.lastInject ?? null
        const everInjected = injected.length > 0 || !!lastInject
        const verbose = args?.verbose === true
        // ⚠️ 可选字段必须**整个键不出现**，不能赋 undefined（2026-11-06 重启后真机暴露）：
        //   宿主校验工具输出用的是「无损 JSON」判定，而 `{ paths: undefined }`
        //   在 JSON.stringify 时会丢掉键，于是回读得到 `{}` 与原始对象**不等**，
        //   宿主直接报 `tool "mind_status" returned invalid output: value is not lossless JSON`，
        //   整个工具调用失败 —— 一个纯粹为了少返回几个字段的写法，把排查工具本身弄坏了。
        //   正确做法：用展开语法按需加键。
        return {
          ok: true,
          plugin: 'dsh-mind',
          dir: MIND_DIR(),
          ...(verbose
            ? { paths: { log: LOG_PATH(), experiences: EXPERIENCE_DIR(), cli: CLI_PATH, peer: PEER_GLOBAL_PATH() } }
            : {}),
          segments: {
            // ⚠️ 2026-11-08 拆分：`strand` 段已搬到 dsh-strand 插件。
            //   这里**仍然报它**，但报的是"对端（软依赖）"的状态，不是本插件的段。
            //   理由：主人问「跨会话记忆是不是没生效」时，第一个动作往往是调 mind_status；
            //   如果它干脆不提这一项，会让人以为功能消失了。
            //   报清楚"在另一个插件里、能不能读到它的数据"，比沉默有用。
            strand: {
              movedTo: 'dsh-strand',
              peerAvailable: readPeerGlobal().available,
              facts: readPeerGlobal().facts.length,
              timeline: readPeerGlobal().timeline.length,
              hint: '跨会话记忆已独立成 dsh-strand 插件，开关与条数用 strand_status 查。',
            },
            tacit: { enabled: config.tacit.enabled, inject: config.tacit.inject },
            psyche: { enabled: config.psyche.enabled, inject: config.psyche.inject, collecting: config.psyche.collectTools },
          },
          // ⚠️ 这三段是「到底有没有生效」的直接答案，不能缺
          inject: {
            everInjected,
            // 当前进程内各窗口的注入时间（重启后为空是正常的）
            windows: injected,
            // 跨重启保留的「上一次注入」，这是"到底注进去没有"的可靠答案
            last: lastInject
              ? { at: lastInject.at, ago: agoText(lastInject.at, now), session: shortId(lastInject.session, 6) }
              : null,
            hint: everInjected
              ? 'last 是跨重启保留的上一次注入记录（最可靠）；windows 只反映当前进程。' +
                '若 last 也是 null，说明本机真的从未注入过。'
              : '一条注入记录都没有：多半是两段都关了、或插件没被宿主加载。先看 segments 的 enabled/inject。',
          },
          // ⚠️ 2026-11-08 拆分：投递（push）已搬到 dsh-strand，这里不再报。
          //   乱报一个"push.enabled=false"会让人以为本插件把投递关了，
          //   实际是它根本不住了。用 movedTo 说清楚。
          push: { movedTo: 'dsh-strand' },
          budget: config.budget,
          windows: { live: live.length, registered: store.windows.size },
          pursuits: store.openPursuits().length,
          ...(verbose ? { config } : {}),
        }
      },
    },

    // ── 取回被压缩折叠掉的原文（可逆摘要，2026-11-05） ──
    //
    // ⚠️ 为什么需要它：
    //   DSH 原生压缩是单向门 —— `commitCompactionBody` 用 surfaceOp:replace
    //   把原文从表层遮蔽，只留摘要。压缩后若需要**精确细节**（报错原文、
    //   逐字引用、路径、数值），只能凭摘要回忆，而摘要必然有损。
    //   有了这个工具，压缩就变成"降采样"而不是"销毁"。
    //
    // ⚠️ 必须显式区分「没存档」和「存档里没这段」：
    //   前者说明压缩发生时存档失败了（要告警），后者说明这个区间本来就没被压缩。
    //   混在一起会让模型把"取不到"误当成"当时没有"。
    //
    // ⚠️ sessionId 必须能省略（2026-11-05）：压缩之后模型**看不到自己的会话 id**，
    //   要求它必填等于这个工具在最需要的时候不可用。改成从 execCtx 自动取。
    {
      name: 'mind_expand',
      description:
        '取回被上下文压缩折叠掉的**原文**。' +
        '压缩是降采样不是销毁：被遮蔽的区间原文已落盘，这里可以按 seq 取回。' +
        '需要精确细节（报错原文、逐字引用、具体路径/数值）时用它，不要凭摘要猜。' +
        '传 seq 取单条，或传 fromSeq+toSeq 取区间；sessionId 可省略（默认当前会话）。',
      parameters: {
        sessionId: { type: 'string', description: '会话 id；省略则用当前会话。' },
        seq: { type: 'number', description: '取某一条具体的 seq。' },
        fromSeq: { type: 'number', description: '区间起点（含）。' },
        toSeq: { type: 'number', description: '区间终点（含）。' },
        list: { type: 'boolean', description: '为 true 时只列出有哪些存档区间，不取内容。' },
        maxChars: { type: 'number', description: '本次最多返回多少字符（默认 60000）。' },
      },
      ...common,
      async execute(args, execCtx) {
        // 当前会话 id：优先用入参，其次从执行上下文推断
        const ctxId =
          execCtx?.agent?.id ?? execCtx?.agent?.session?.id ?? execCtx?.session?.id ?? null
        const sid = String(args?.sessionId ?? '') || ctxId || null

        // 列清单
        if (args?.list === true) {
          const files = listArchives(sid)
          if (files.length === 0) {
            return {
              ok: true,
              archives: [],
              hint: sid
                ? `会话 ${sid} 没有任何存档。可能是：(a) 还没发生过压缩；(b) 压缩时存档失败（去看 mind.log 里的「压缩存档」行）。`
                : '当前没有任何存档。',
            }
          }
          return {
            ok: true,
            archives: files.map((f) => {
              const m = /__(\d+)-(\d+)\.json$/.exec(f.file)
              return {
                range: m ? `${m[1]}..${m[2]}` : f.file,
                fromSeq: m ? Number(m[1]) : null,
                toSeq: m ? Number(m[2]) : null,
                kb: Math.round(f.bytes / 1024),
                at: new Date(f.mtime).toISOString(),
              }
            }),
          }
        }

        if (!sid) {
          return {
            ok: false,
            error: '拿不到会话 id（execCtx 里没有 agent）。请显式传 sessionId，或先 list:true 看看有哪些存档。',
          }
        }

        const res = expandRegion({
          sessionId: sid,
          seq: args?.seq,
          fromSeq: args?.fromSeq,
          toSeq: args?.toSeq,
          ...(typeof args?.maxChars === 'number' ? { maxChars: args.maxChars } : {}),
        })

        if (!res.hit) {
          return {
            ok: true,
            hit: false,
            range: res.range,
            hint:
              `区间 ${res.range} 在存档里没有内容。两种可能：` +
              '① 这段从未被压缩（那它应该还在当前上下文里，直接看即可）；' +
              '② 压缩发生时存档失败——传 list:true 看看有没有任何存档。',
          }
        }

        return {
          ok: true,
          hit: true,
          restoredFrom: res.source,
          range: res.range,
          chars: res.chars,
          truncated: res.truncated,
          text: res.text,
          ...(res.truncated ? { hint: '输出被 maxChars 截断，缩小区间或调大 maxChars 再取。' } : {}),
        }
      },
    },

    // ── 在压缩掉的存档里搜关键词 ──
    //
    // ⚠️ 为什么它比 mind_expand 更常用（2026-11-06 加，思路来自 billion-context）：
    //   mind_expand 要**先知道 seq**，可压缩之后模型根本不知道 seq 是多少。
    //   "想不起完整的，只记得关键词" 才是压缩后最常见、也最要命的状态 ——
    //   不知道自己丢了什么，就不会去查。
    //   这条链路是：想得起关键词 → mind_search → 拿到 seq → mind_expand 取全文。
    {
      name: 'mind_search',
      description:
        '在被上下文压缩折叠掉的**原文存档**里按关键词搜索。' +
        '压缩后常见的困境是「只记得大概，想不起完整内容，也不知道 seq 是多少」——' +
        '那就先搜这里，拿到 seq 再调 mind_expand 取全文。' +
        '多个词用空格分隔表示**都要命中**（AND）；中文按子串匹配，不需要切词。' +
        '只返回摘要行不返回全文，所以搜索本身很省。sessionId 可省略（默认当前会话）。',
      parameters: {
        query: { type: 'string', description: '关键词。多个用空格分隔（全部都要出现）。中文直接写，不需要切词。' },
        sessionId: { type: 'string', description: '会话 id；省略则用当前会话。' },
        limit: { type: 'number', description: '最多返回几条（默认 10）。' },
        ctxChars: { type: 'number', description: '每条预览多少字符（默认 120）。' },
      },
      ...common,
      async execute(args, execCtx) {
        const ctxId =
          execCtx?.agent?.id ?? execCtx?.agent?.session?.id ?? execCtx?.session?.id ?? null
        const sid = String(args?.sessionId ?? '') || ctxId || null
        const query = String(args?.query ?? '').trim()
        if (!query) return { ok: false, error: 'query 不能为空' }

        const r = searchArchives({
          sessionId: sid,
          query,
          // ⚠️ 必须夹界（2026-11-06 修）：原来只判 Number.isFinite，
          //   于是 limit=-5 / ctxChars=0 会原样透传下去 ——
          //   limit 负数被 archive.js 的 Math.max(1,...) 兜住，但 ctxChars=0
          //   会让每条预览变成空串，返回一堆只有 seq 的空行，看着像"搜到了却没内容"。
          //   上界也必须有：limit=100000 一次吐几万条会把上下文直接灌爆。
          limit: Math.max(1, Math.min(100, Number(args?.limit) || 10)),
          ctxChars: Math.max(40, Math.min(2000, Number(args?.ctxChars) || 120)),
        })
        if (!r.ok) return r
        if (r.hits.length === 0) {
          return {
            ok: true,
            hits: [],
            message:
              `在 ${r.files} 个存档 / ${r.scanned} 条里没找到「${r.query}」。` +
              '换个词试试，或用 mind_expand 传 list:true 看有哪些区间。',
          }
        }
        log(`存档搜索 :: ${shortId(String(sid ?? '?'), 6)}「${query}」命中 ${r.total} 条（扫 ${r.scanned} 条）`)
        return {
          ...r,
          hint: '拿到 seq 后调 mind_expand({seq}) 取那一条的全文。',
        }
      },
    },

    // ── 主动压缩（D 项）：自己决定什么时候折，不等宿主的 80% 阈值 ──
    //
    // ⚠️⚠️ 这个工具**不在本次调用内压缩**，只登记意图。原因不是保守，是硬时序：
    //   `compactNow()` 在 `compactSurfaceRegion` 里第一句就检查 openTurn，
    //   非 null 就抛 ManualCompactionError('busy')（_extract-compactbasic/lib/index.js:457），
    //   而工具调用必然发生在 turn 之内 → 直接调 100% 失败。
    //   真正的压缩由 index.js 的 agent/status(idle) 触发。
    //   所以工具返回 `queued` 是**正确语义**，不是"没做成"。
    //
    // ⚠️ 结果怎么回来：压缩完成后，下一回合注入的最前面会出现
    //   「### 主动压缩结果（dsh-mind 回报，非用户输入）」，不必反复查。
    {
      name: 'mind_compress',
      description:
        '请求一次**主动压缩**：把较早的历史折叠成摘要，释放上下文余量。' +
        '与宿主自动压缩的区别是**由你决定时机**，而不是等到压力阈值。' +
        '⚠️ 本工具只**排队**：真正的压缩在你这一回合结束后、agent 变空闲时执行（工具内无法压缩，见实现注释）。' +
        '压缩前的原文会落盘，之后可用 mind_expand 按 seq 取回；压缩结果会在下一回合的注入里回报。' +
        '想确认有没有排上，看返回的 status；别再重复调用（同一会话只排一个）。',
      parameters: {
        why: { type: 'string', description: '一句话说明为什么现在要压（会记进日志与回报，便于回看）。' },
      },
      ...common,
      async execute(args, execCtx) {
        const agent = execCtx?.agent ?? null
        if (!agent) {
          return {
            ok: false,
            error: '拿不到当前 agent（execCtx 里没有 agent），主动压缩无法排队。',
          }
        }
        const res = Proactive.requestCompact(agent, args?.why || '模型主动请求')
        const statusText = {
          queued: '已排队。这一回合结束、agent 空闲后执行；结果会在下一回合注入里回报。',
          'already-pending': '已经排着一个了，这次没有重复排队。等它执行完看下一回合的回报。',
          'already-running': '正在压缩中，别重复请求。',
          'no-agent': '拿不到 agent，没排上。',
        }
        return {
          ok: !!res.ok,
          status: res.status,
          hint: statusText[res.status] ?? '',
          why: res.why ?? args?.why ?? null,
        }
      },
    },
  ]
}

/** 供 psyche 段渲染使用（工具名 → 人话）。 */
export { PsycheSegment }
