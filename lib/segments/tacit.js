/**
 * dsh-mind · 规范段：经验库自动命中
 *
 * CCG 六要素:
 *   功能名   tacit 段：按信号命中经验条目，命中的才进上下文
 *   生效条件 config.tacit.enabled && config.tacit.inject
 *   子功能   经验解析（frontmatter）/ 信号推导 / 条件求值 / 命中集合去重 / 渲染
 *   执行     load() 读磁盘并缓存 2 秒；match() 纯函数；render() 纯函数
 *   验证方式 tests/regress.mjs 经验组（16 项，含反向：只有"B站"没有动作→零注入）
 *   不适用条件 判断一条经验的**内容**对不对（那是语义，本段只做确定性命中）
 *
 * 三条设计（移植自 dsh-superagent-prototype 的 experiences.ts）：
 *   1. 命中才注入 —— 没命中一个字都不进上下文
 *   2. 不认识的条件下匹配失败 —— 照猜去动手，比安静更糟
 *   3. 信任分级 —— L1/L2/L3/L4 决定它敢做什么
 *
 * 为什么不用水位（与 strand 不同）：经验的命中集合由「当前在做什么」决定，
 * 不是由时间推进决定。同一件事连着做十步，经验只该进一次；
 * 做完换个事再回来，才该重新进。所以判据是「本次命中的 id 集合」是否变过。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { EXPERIENCE_DIR } from '../io.js'
import { MARK_TACIT } from '../message.js'

export { MARK_TACIT }

/** 单次注入上限，防止经验写太多把上下文挤爆。 */
export const MAX_CHARS = 1200

/** 一次最多命中几条。 */
export const MATCH_LIMIT = 3

/** 经验文件缓存时长（目录 mtime 之外的轻量缓存；改文件不至于要重启）。 */
const CACHE_MS = 2000

let cache = { at: 0, dir: '', items: [] }

// ─────────────────────────── 解析 ───────────────────────────

/**
 * 解析一个经验文件。
 *
 * 返回 undefined 表示"这条不该用"，三种情况：
 *   - 没有 frontmatter / 没有 trigger
 *   - `enabled: false`
 *   - 文件读不到
 *
 * ⚠️ 一个坏文件不该让整库读不出来 —— 调用方逐个 try。
 */
export function parse(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (!m) return undefined
  const [, header = '', rawBody = ''] = m
  const front = {}
  for (const line of header.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line.trim())
    if (pair) front[pair[1]] = pair[2].trim()
  }
  const body = rawBody.trim()
  const id = front.id || file.replace(/\.md$/i, '')
  if (!id || !front.trigger) return undefined
  if (front.enabled === 'false') return undefined
  return {
    id,
    trigger: front.trigger,
    condition: front.condition ?? 'true',
    action: front.action ?? '',
    trust: (front.trust_level ?? 'L3').toUpperCase(),
    title: (/^#\s+(.+)$/m.exec(body)?.[1] ?? id).trim(),
    body,
  }
}

/**
 * 读全库（带 2 秒缓存）。
 *
 * ⚠️ 缓存键必须包含 **dir**（2026-11-06 修）：
 *   原来只按时间缓存，于是同一个进程里 `loadExperiences(临时目录)` 之后再
 *   `loadExperiences(真实目录)`，2 秒内拿到的是**上一份目录的结果** ——
 *   真实经验库读出来是空的，端到端判据假红/假绿都可能。
 *   第 43 组一直在读真实库，只是它跑在前面、缓存还没被别的目录占用，才侥幸没暴露。
 */
export function loadExperiences(dir = EXPERIENCE_DIR()) {
  const now = Date.now()
  const key = String(dir)
  if (now - cache.at < CACHE_MS && cache.dir === key) return cache.items
  let names
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    cache = { at: now, dir: key, items: [] }
    return cache.items
  }
  const out = []
  for (const n of names) {
    const f = join(dir, n)
    try {
      if (!statSync(f).isFile()) continue
      const p = parse(readFileSync(f, 'utf8'), f)
      if (p) out.push(p)
    } catch {
      /* 一个坏文件不该让整库读不出来 */
    }
  }
  cache = { at: now, dir: key, items: out }
  return out
}

/** 测试用：清缓存。 */
export function _clearCache() {
  cache = { at: 0, dir: '', items: [] }
}

// ─────────────────────────── 匹配 ───────────────────────────

/**
 * 信号路径匹配。
 *
 * 支持四种形式，其余按"同族"匹配：
 *   `**` / `*`            → 全匹配
 *   `a.b.**`              → a.b 及其所有后代
 *   `a.*.c`               → 单段通配
 *   `a.b`                 → a.b 及其后代（`a.b.c` 也算）
 *   同族：`file.created` 也适用于 `file.modified` / `file.deleted`
 */
export function triggerMatches(trigger, path) {
  const t = String(trigger ?? '').trim()
  if (!t || !path) return false
  if (t === '**' || t === '*') return true
  if (t.endsWith('.**')) return path === t.slice(0, -3) || path.startsWith(t.slice(0, -2))
  if (t.includes('*')) {
    const re = new RegExp(
      `^${t
        .split('.')
        .map((s) => (s === '*' ? '[^.]+' : s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
        .join('\\.')}$`,
    )
    return re.test(path)
  }
  if (path === t || path.startsWith(`${t}.`)) return true
  const want = t.split('.')
  const got = path.split('.')
  return (
    want.length === got.length &&
    want.length > 1 &&
    want.slice(0, -1).join('.') === got.slice(0, -1).join('.')
  )
}

/**
 * 条件求值。只支持三种写法，其余**一律 false**。
 *
 * ⚠️ 这是刻意的：解析不了的条件如果返回 true，等于"照猜去动手"，
 *   比安静（不命中）更糟。
 */
export function conditionHolds(condition, context) {
  const c = String(condition ?? 'true').trim()
  if (!c || c === 'true') return true
  if (c === 'false') return false
  const pick = (path) =>
    path.split('.').reduce((acc, key) => (acc && typeof acc === 'object' ? acc[key] : undefined), context)
  const eq = /^([A-Za-z_][\w.]*)\s*==\s*(.+)$/.exec(c)
  if (eq) return String(pick(eq[1]) ?? '') === eq[2].trim().replace(/^["']|["']$/g, '')
  const inList = /^([A-Za-z_][\w.]*)\s+in\s+\[(.*)\]$/.exec(c)
  if (inList) {
    const allowed = inList[2]
      .split(',')
      .map((x) => x.trim().replace(/^["']|["']$/g, '').toLowerCase())
    return allowed.includes(String(pick(inList[1]) ?? '').toLowerCase())
  }
  return false
}

/** 命中质量：0/1 = 精确或通配（正常命中），2 = 仅靠"同族"兜底。越大越弱。 */
function matchQuality(trigger, path) {
  const t = String(trigger ?? '').trim()
  if (!t || !path) return -1
  // 精确 / 前缀：最可靠
  if (path === t || path.startsWith(`${t}.`)) return 0
  // 通配：作者显式写了模式，也算正常命中
  if (t === '**' || t === '*' || t.endsWith('.**') || t.includes('*')) return 1
  // 剩下的都靠"同族"规则命中（file.created 之于 file.modified）
  return 2
}

/** 命中集合（按 id 排序，取前 limit 条 —— 顺序稳定才能做"同一组不重复注入"的比较）。 */
export function matchExperiences(path, context, limit = MATCH_LIMIT, dir = EXPERIENCE_DIR()) {
  const hits = loadExperiences(dir)
    .filter((e) => triggerMatches(e.trigger, path) && conditionHolds(e.condition, context))
    .map((e) => ({ e, q: matchQuality(e.trigger, path) }))
  // ⚠️ 2026-11-04 修：同族匹配只是**兜底**，不能和有精确命中的平起平坐。
  //   旧行为下 `task.cuda-compile` 会被 `task.spawn-python` 信号命中（同族），
  //   于是 pip 装包都会带出那条 1400 字的 CUDA 历史，把名额挤掉。
  //   现在：只要该信号下有精确/通配命中，就完全丢弃仅靠同族的条目。
  const hasPrecise = hits.some((h) => h.q <= 1)
  return hits
    .filter((h) => !hasPrecise || h.q <= 1)
    .sort((a, b) => (a.q !== b.q ? a.q - b.q : a.e.id.localeCompare(b.e.id)))
    .slice(0, limit)
    .map((h) => h.e)
}

/**
 * 按**多个**信号一起匹配，取并集。
 *
 * ⚠️ 为什么需要（2026-11-03 第二阶段）：
 *   一句话里同时提到两件事很常见（"装插件时报 python 找不到"）。
 *   只按第一个信号匹配，另一条经验就白白浪费了。
 *   并集之后按"信任等级更严的优先 + id 稳定排序"截断，保证同一输入的输出稳定
 *   （输出不稳定会让「同一组经验不重复注入」的判据失效）。
 *
 * 稳定性：先去重（同 id 只留一条），再按 trust 升序（L1 最严在前），再按 id。
 */
export function matchBySignals(signals, limit = MATCH_LIMIT, dir = EXPERIENCE_DIR()) {
  if (!Array.isArray(signals) || signals.length === 0) return []
  const seen = new Map()
  for (const sig of signals) {
    for (const e of matchExperiences(sig.path, sig.context, limit, dir)) {
      if (!seen.has(e.id)) seen.set(e.id, e)
    }
  }
  const TRUST_ORDER = { L1: 0, L2: 1, L3: 2, L4: 3 }
  return [...seen.values()]
    .sort((a, b) => {
      const ta = TRUST_ORDER[a.trust] ?? 9
      const tb = TRUST_ORDER[b.trust] ?? 9
      if (ta !== tb) return ta - tb // L1（最严）优先
      return a.id.localeCompare(b.id) // 同级按 id，保证稳定
    })
    .slice(0, limit)
}

// ─────────────────────── 从对话推出信号 ───────────────────────
//
// ⚠️ 这里必须克制：**宁可漏，不可误命中**。
//   误命中会把不相关的经验塞进上下文，比不注入更糟。

function mentions(text, words) {
  const t = String(text ?? '').toLowerCase()
  return words.some((w) => t.toLowerCase().includes(w.toLowerCase()))
}

/**
 * 否定从句识别（2026-11-06 修 B）。
 *
 * ⚠️ 血证：`不要修改任何文件` 命中了 task.after-change ——
 *   判据里裸词「修改」不看上下文，把**禁止**读成了**已做**。
 *   这类误命中比漏命中更糟：它会把「改动后要验证」的经验塞进一个
 *   明确什么都不改的回合里，模型要么被误导，要么学会忽略这条经验。
 *
 * 做法不是给词表打补丁（「别改」「不用改」「无需修改」组合无穷），
 * 而是先按标点切从句，**含否定式动作的从句整段丢弃**，再判改动信号。
 * 这样「不要动 X，但把 Y 改好了」仍能命中 —— 被丢的只有前半句。
 */
const NEGATED_ACTION =
  /(?:不|别|勿|甭|无需|不用|不必|不需要|没有|没|未)[^，,。.！!？?；;、\n]{0,10}?(?:改|修改|调整|动|碰|写|存|保存|编辑|更新|设置|重启|restart|reload|重新加载)/

function stripNegatedClauses(text) {
  const raw = String(text ?? '')
  if (!NEGATED_ACTION.test(raw)) return raw
  return raw
    .split(/(?<=[，,。.！!？?；;、\n])/)
    .filter((seg) => !NEGATED_ACTION.test(seg))
    .join('')
}

/**
 * 信号推导表。
 *
 * ⚠️ **这张表必须与经验库里实际在用的 trigger 对齐**（2026-11-03 第二阶段修）：
 *   整合前 `deriveSignal` 只能产出 4 类信号
 *   （task.bili-write / task.plugin-install / task.spawn-python / task.session-repair），
 *   而经验库实际用了 11 类 trigger —— 15 条经验里 **7 条永不自启**（47%）。
 *   那 7 条恰好都是"出错时最该看"的：沙箱拒绝、大输出纪律、改动后验证、
 *   对端注入降级、插件 peer 自供、JSON 编码陷阱、文件读写。
 *
 *   现在的做法：不凭印象列关键词，而是**按经验库实际 trigger 逐条建规则**，
 *   且 `tests/regress.mjs` 有一条判据专门盯着"经验库里的每个 trigger 都有对应信号"，
 *   以后加经验忘了加信号，测试会红。
 *
 * 每条规则的形态：{ path, test(text, lower) → context | undefined }
 *   - 返回 undefined = 这条规则不命中（不是"命中但没上下文"）
 *   - 命中但判不出上下文时也要返回 undefined，让 condition 自然失败
 */
const SIGNAL_RULES = [
  // ── 任务类 ──
  {
    path: 'task.bili-write',
    test(t) {
      // ⚠️ 2026-11-06 修 C：两个方向都错过。
      //   ① 裸词「动态」当动作 → 纯读场景（「刷一下 B 站动态」）也命中，
      //      把「公开发布要先给主人看」的 L1 经验塞进只读回合里；
      //   ② 「发条动态」反而不命中 —— 原来只认「发动态」这三个连着写的字，
      //      中间插一个「条」就漏了。
      //   现在：动作必须带**写类动词**，用正则容忍中间插字；裸词一律不算。
      if (!mentions(t, ['b站', 'b 站', 'bilibili', '哔哩'])) return undefined

      let action
      if (/投稿|上传(视频|稿件)|发(个|一)?视频/.test(t)) action = 'upload'
      else if (/私信|发消息给/.test(t)) action = 'dm'
      else if (/发[^，,。.？?]{0,8}动态/.test(t)) action = 'dynamic'
      else if (/(回复|回)[^，,。.？?]{0,8}评论/.test(t)) action = 'reply'
      else if (/(发|写|留)[^，,。.？?]{0,8}评论/.test(t)) action = 'comment'
      // 动作必须能从字面判出来；判不出就不给 context
      return action ? { action } : undefined
    },
  },
  {
    path: 'task.plugin-install',
    test(t) {
      if (!mentions(t, ['装插件', '安装插件', 'add plugin', 'plugin add', '装进 profile', 'node_modules', '插件装'])) return
      // target 决定命中哪几条：提到 profile / 桌面 profile 就是 profile 级操作
      const target = mentions(t, ['profile', 'desktop']) ? 'profile' : 'plugin'
      return { target }
    },
  },
  {
    path: 'task.spawn-python',
    test(t, lower) {
      // ⚠️ 2026-11-06 修 E：裸词 `'.py'` 会匹配 `.pyc` / `.pyo`。
      //   实测「看看 .pyc 文件」命中了 task.spawn-python，把
      //   python-absolute-path 那条 L1 塞进一个只是看编译产物的回合里。
      //   改成要求 `.py` 后面不能再接字母数字（`.py` 结尾或后跟非字母）。
      const isPy = mentions(lower, ['python', 'py 脚本', 'pip ']) || /\.py(?![a-z0-9])/.test(lower)
      if (!isPy) return
      return { shell: 'pwsh' }
    },
  },
  // ── CUDA / Pascal 编译（trigger: task.cuda-compile）──
  //
  // ⚠️ 2026-11-04 新增：cuda-indextts-legacy 原本挂 task.spawn-python，
  //   导致 pip 装包、跑任何 py 脚本都会把那条 1400 字的历史排错拉进来，
  //   挤占 3 条名额。本机已无 IndexTTS 项目，故拆成独立窄信号。
  //   宁可漏 —— 只有明确提到 CUDA/GPU 编译才命中。
  {
    path: 'task.cuda-compile',
    test(t, lower) {
      const isCuda = mentions(lower, ['cuda', 'nvcc', 'cudatoolkit', 'torch.cuda', 'sm_61', 'pascal', 'bigvgan', 'indextts'])
      if (!isCuda) return
      return { shell: 'pwsh' }
    },
  },
  {
    path: 'task.session-repair',
    test(t) {
      if (!mentions(t, ['会话损坏', 'inbox', 'seq ', '重放', '会话被拒', '会话坏了'])) return
      return { symptom: 'inbox-id' }
    },
  },

  // ── 大输出纪律（trigger: task.large-output）──
  //
  // 何时该提醒"大输出写文件"：
  //   ① 用户明确要求扫全量 / 全库 / 全部文件 / 统计一遍
  //   ② 用户要看某个函数的实现（容易顺手 dump 整段）
  {
    path: 'task.large-output',
    test(t) {
      const wantsScan =
        mentions(t, ['全量', '全部文件', '全库', '扫一遍', '扫全', '统计一遍', '整个目录', '所有文件', '全盘']) ||
        /扫描|遍历|汇总所有/.test(t)
      const wantsDump = mentions(t, ['整个函数', '完整实现', '全部代码', 'dump 出来', '打印全部'])
      if (!wantsScan && !wantsDump) return
      return { estimate: wantsDump ? 'full-dump' : 'large' }
    },
  },

  // ── 改动后验证（trigger: task.after-change）──
  //
  // 触发点：用户说"改完了吗 / 生效了吗 / 验证一下 / 重启了没有"，
  //        或明确提到改插件代码 / 改配置 / 改技能 / 后台任务。
  //
  // ⚠️ 2026-11-06 放宽（实测漏得太狠）：
  //   拿主人 14 句真实原话测，这条**一次都没命中**，包括
  //   「改完这个插件重启看看」「我刚改了 config.json」这种教科书场景。
  //   原因：原来只认「改完了吗 / 生效了吗」这种**完整问句**，以及
  //   「改了配置 / 插件代码」这种**带宾语**的说法。
  //   而主人实际说话极短：「改了」「改好了」「重启了」「生效了」。
  //   判据从「必须问句+宾语齐全」改成「提到改动 OR 提到验证 OR 提到重启」，
  //   任一项成立即命中 —— 这条经验本身是提醒「改完要验证」，
  //   宁可多抬一次，也不要该抬的时候不抬。
  {
    path: 'task.after-change',
    test(t) {
      // ⚠️ 先剥掉否定从句（2026-11-06 修 B）：
      //   「不要修改任何文件」被判成"改了东西"是纯粹的反向误命中。
      //   剥完若整句变空串，说明这句话整个都在讲"别做什么"，自然不命中。
      const t2 = stripNegatedClauses(t)
      if (!t2.trim()) return undefined
      const lower = t2.toLowerCase()

      // ① 直接问「生效/验证」
      const asksVerify = mentions(t2, [
        '生效了吗', '改完了吗', '验证一下', '验证下', '有没有生效', '现在生效',
        '确认一下生效', '起作用了吗', '生效了', '生效没', '验证过', '验一下',
      ])

      // ② 提到改了什么（原来要求"改+配置/代码"两段齐全，现在只要"改"就算）
      const touchedSomething = mentions(t2, [
        '改配置', '改了配置', '改过配置', '插件代码', '改了插件', '改了代码',
        '改了', '改好', '改完', '改过', '修改', '调整了',
      ])

      // ③ 提到重启（重启几乎总是「改动之后」的信号）
      const restarted = mentions(t2, ['重启', 'restart', '重新加载', 'reload'])

      if (!asksVerify && !touchedSomething && !restarted) return

      // what 的判定：按具体程度从高到低
      let what = 'config'
      if (mentions(t2, ['插件', 'plugin', '代码', 'code'])) what = 'plugin-code'
      else if (mentions(t2, ['技能', 'skill'])) what = 'hook'
      else if (mentions(t2, ['后台', 'background', '任务'])) what = 'background-job'
      else if (mentions(lower, ['config', '配置', 'json', '.yml', 'yaml'])) what = 'config'
      return { what }
    },
  },

  // ── 对端注入（trigger: input.peer）──
  //
  // ⚠️ 这条最特殊：它的信号不是"用户说了什么"，而是**上下文里有没有别的窗口注入**。
  //   deriveSignal 只看用户文本，所以这里判"用户提到了那些注入 / 多窗口"。
  //   真正的护栏在 isSelfMessage（那些注入根本不进采集），这条只负责在
  //   用户主动讨论"另一个窗口说的话算不算数"时把准则抬上来。
  {
    path: 'input.peer',
    test(t) {
      if (!mentions(t, ['另一个窗口', '别处', '跨窗口', '别的会话', '另一个会话', 'peer', '自动投递', '自动注入'])) return
      return { source: 'other-window' }
    },
  },

  // ── 工具报错（trigger: tool.error）──
  //
  // 用户把报错原文贴过来的情形。关键判据：出现 sandbox / 拒绝访问 / EPERM 这类词。
  //
  // ⚠️ 2026-11-06 放宽（实测漏得太狠）：
  //   原来只认沙箱/权限类词。实测「为什么这个报错」→ 0 命中。
  //   但主人平时说「报错」根本不会带 sandbox 字样，他只会说「报错了」「报这个错」
  //   「失败了」「跑不通」。而经验库里 tool.error 下挂的是
  //   sandbox-deny-triage（沙箱拒绝判读）——它在**沙箱报错**时最有用，
  //   在**普通报错**时也会给"这是不是沙箱问题"的判断线索，不算噪声。
  //   所以改成：沙箱类词 → kind:sandbox（精准）；普通报错词 → kind:error（泛化）。
  {
    path: 'tool.error',
    test(t) {
      const lower = String(t ?? '').toLowerCase()

      // ① 沙箱/权限类：精准命中
      const isSandbox = mentions(t, [
        'sandbox', '沙箱', '拒绝访问', 'access denied', 'access-denied',
        'EPERM', 'EACCES', '权限不足', '被拒绝', '无权限',
      ])
      if (isSandbox) return { kind: 'sandbox' }

      // ② 普通报错：泛化命中
      //    ⚠️ 判据必须比"提到错误"更窄一点，否则每句讨论都会命中。
      //    要求出现「报错/失败了/跑不通 + 疑问或指代」，避免"报了个假错"这种叙述。
      const genericError = mentions(t, [
        '报错', '报这个错', '报了个错', '失败', '跑不通', '不工作', '没反应',
        '异常', 'crash', '崩溃',
      ]) || /\berror\b|exception|traceback/i.test(lower)
      if (genericError) return { kind: 'error' }

      return
    },
  },

  // ── JSON / 编码（trigger: file.json 与 file.**）──
  //
  // ⚠️ 这两条经验的 condition 是 `true`，只要信号命中就一定注入。
  //   所以判据必须**足够窄**，否则每次聊到文件都会注入，变成噪声。
  //   只在"正在碰中文 JSON / 编码出问题"时命中。
  {
    path: 'file.json',
    test(t) {
      // ⚠️ 先剥否定从句：「别改 json」「不用动 json」不是要写 json。
      const t2 = stripNegatedClauses(t)
      if (!mentions(t2, ['json'])) return
      // ① 明确碰编码问题 → 直接命中
      if (mentions(t2, ['中文', '编码', '乱码', 'bom', 'BOM'])) return {}

      // ② 提到「改/写 json 文件」→ 也命中（2026-11-06 放宽）
      //
      // ⚠️ 为什么放宽：原来要求「json + 中文/编码」同时出现。
      //   实测「我刚改了 config.json」→ 0 命中，而这条经验的正文
      //   讲的正是「往本机含中文的 JSON 写东西要防 BOM」。
      //   主人改 config.json 时根本不会特意说「中文」，
      //   可不防的话 BOM 就会让宿主读不动 —— 恰恰是该提醒的时刻没提醒。
      //
      // ⚠️⚠️ 但第一版放宽放坏了（2026-11-06 修 D）：
      //   判据里放了**单字**「改/写/存/设置」，于是
      //   `json 存档在哪` 命中（「存」是 存档 的第一个字，纯名词），
      //   `json 格式是什么` 也可能被蹭到 —— 而 file.json 那条经验的
      //   condition 是 `true`，一旦命中就**必然注入并挤占 3 个名额**。
      //   实测 `json 存档在哪` 同时命中两条 condition:true 的经验，吃掉 2/3 名额。
      //
      //   现在要求两件事同时成立：
      //     ① 动词必须是**写类动词**，且 `存` 后面不能接 档/放/储（排除名词）；
      //        单字「改」也拆开成「改了/改过/改好/改完/改成/改为/改写/改掉」，
      //        否则「改天再说」里的「改」会被误算成写动作。
      //     ② 动词与 json 之间最多隔 40 个字符（够跨过 `config.` 这类文件名，
      //        但跨不过中文标点 —— 所以「改了 A，json 那边」这种分句不会被连起来）。
      //        ⚠️ 排除列表里**不能含英文 `.`**：`config.json` 的点号就在中间，
      //        第一版把它排掉了，于是「我刚改了 config.json」→ 0 命中（实测）。
      const VERB =
        '(?:修改|编辑|更新|设置|保存|改成|改为|改写|改掉|改了|改过|改好|改完|改|' +
        '写入|写出|写|存(?!档|放|储)|加|生成|输出|填)'
      const GAP = '[^，,。！!？?；;、\\n]{0,40}'
      const writeIntent = new RegExp(`(?:${VERB})${GAP}json|json${GAP}(?:${VERB})`, 'i')
      if (writeIntent.test(t2)) return {}
      return
    },
  },
  {
    path: 'file.**',
    test(t) {
      // profile-json-no-bom 覆盖的是"读写本机含中文的文件"。
      // 只在明确提到写文件路径 + 中文时命中，避免泛化。
      if (!mentions(t, ['写文件', '读文件', '写入', '保存到', '改成', '改配置'])) return
      if (!mentions(t, ['中文', '编码', '乱码', 'bom'])) return
      return {}
    },
  },

  // ── 插件 peer 自供（trigger: plugin.**）──
  //
  // 只在用户贴出 "Cannot find package" / "failed to import" 这类宿主报错时命中。
  {
    path: 'plugin.npm-error',
    test(t) {
      const isMissingPkg = /cannot find package|failed to import|ERR_MODULE_NOT_FOUND|module not found/i.test(t)
      if (!isMissingPkg) return
      return {}
    },
  },
]

/**
 * 从最近一条用户输入推出 { 信号路径, 上下文 }。
 *
 * ⚠️ 上下文是**必需**的，不是可选装饰：经验的条件（`action in [...]`）
 *   全靠它求值。只给信号不给上下文，条件永远取不到值 → 一律 false → 永不命中。
 *   2026-11-02 在这上面栽过一次（7/10 测试全红）。
 *
 * 仍然是**确定性字面判断**，不做语义推理——语义推理本来就该是模型干的。
 *
 * @returns {{path:string, context:object}|undefined} 命中的第一条规则
 */
export function deriveSignal(text) {
  const t = String(text ?? '')
  if (!t) return undefined
  const lower = t.toLowerCase()

  for (const rule of SIGNAL_RULES) {
    let ctx
    try {
      ctx = rule.test(t, lower)
    } catch {
      ctx = undefined // 单条规则炸了不影响其他
    }
    if (ctx === undefined) continue
    return { path: rule.path, context: ctx }
  }
  return undefined
}

/**
 * 推出**所有**可能的信号（不只第一条）。
 *
 * ⚠️ 为什么需要这个（2026-11-03 第二阶段）：
 *   `deriveSignal` 只返回第一条命中的规则。一句话里同时提到
 *   "装插件"和"python 绝对路径"时，只会命中一条，另一条的经验白放着。
 *   而经验的条件本来就各不相同，同时命中多条正是设计意图（最多取 3 条）。
 *
 *   保留 deriveSignal 的行为不变（旧测试依赖它只返回一条），
 *   让 matchExperiences 用这个更全的版本。
 */
export function deriveSignals(text) {
  const t = String(text ?? '')
  if (!t) return []
  const lower = t.toLowerCase()
  const out = []
  for (const rule of SIGNAL_RULES) {
    try {
      const ctx = rule.test(t, lower)
      if (ctx !== undefined) out.push({ path: rule.path, context: ctx })
    } catch {
      /* 单条规则失败不影响其他 */
    }
  }
  return out
}

/** 供测试与诊断：列出本模块认识的所有信号路径。 */
export function knownSignalPaths() {
  return SIGNAL_RULES.map((r) => r.path)
}

// ─────────────────────────── 渲染 ───────────────────────────

/** 把 Experience 拼成给模型看的一段；超长时按条裁剪。 */
export function render(hits, maxChars = MAX_CHARS) {
  if (!hits || hits.length === 0) return ''
  const lines = [MARK_TACIT, '（这条是经验库自动命中的，不是主人说的话。照它办，但它不改红线。）', '']
  let used = 0
  for (const exp of hits) {
    const piece = `- ${exp.id}（${exp.trust}）${exp.title ? ` · ${exp.title}` : ''}\n  ${exp.action}`
    if (used + piece.length > maxChars) break
    lines.push(piece)
    used += piece.length
  }
  return lines.join('\n')
}

/** 命中集合的稳定键，用于「同一组不重复注入」。 */
export function hitsKey(hits) {
  return hits.map((e) => e.id).sort().join(',')
}
