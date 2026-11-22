/**
 * dsh-mind · 配置
 *
 * CCG 六要素:
 *   功能名   唯一配置入口（旧的三个插件各有自己的配置读取）
 *   生效条件 lib/index.js 启动时读一次；无配置文件即全开
 *   子功能   缺省全开 / 未知键忽略 / 坏文件回退 / 旧的 psyche.json 兼容
 *   执行     纯 JSON 文件，不用 Config schema（理由见下）
 *   验证方式 tests/regress.mjs 配置组（缺省值、显式关闭、未知键、坏文件）
 *   不适用条件 需要宿主 UI 上可视化编辑（那才需要 schemastery）
 *
 * ⚠️ 为什么用 JSON 文件而不是 Config schema（沿用 dsh-memory-hub 的结论）：
 *   Config schema 需要 @deepseek-ai/schemastery。按本机红线，第三方插件的
 *   dependencies 要在**插件自己目录**里装，而 profile 的依赖树不许碰。
 *   一个只有十几个布尔/数字的开关，不值得为此承担依赖风险。
 *
 * ⚠️ 为什么缺省全开：缺配置就静默停摆，是这类插件最难查的故障。
 *   "没配置"应当等于"照默认跑"，不应当等于"什么都不做"。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { log } from './io.js'

const CONFIG_PATH = () => process.env.MIND_CONFIG || join(homedir(), '.dsh', 'mind.json')
const LEGACY_PSYCHE_CONFIG = () => join(homedir(), '.dsh', 'psyche.json')

export const DEFAULT_CONFIG = {
  enabled: true,

  // ── 两段各自的开关 ──
  //
  // ⚠️ 2026-11-08 拆分：`strand` 段已搬到 **dsh-strand** 插件。
  //   这里**故意不再保留** strand 键 —— 留着它会让 `mergeKnown` 把一个
  //   "看起来能开关跨会话"的键继续接受下来，而实际上本插件什么都不做。
  //   那是最坏的一种配置：写得进去、读得出来、就是没效果。
  //   旧 `~/.dsh/mind.json` 里的 `strand` 段会被**忽略**（未知键），
  //   对应的开关由 dsh-strand 从同一个文件里读走（见那边的 config.js）。
  tacit: {
    enabled: true,
    inject: true,
  },
  psyche: {
    enabled: true,
    collectTools: true, // 采集工具动作（「正在做什么」）
    inject: true,
  },

  // ── 统一注入预算（字符）──
  //
  // ⚠️ 拆分后的分配：原来 total 12000 = strand 9000 + tacit 1200 + psyche 1200。
  //   strand 搬走后本插件只剩两段 + 日记。
  //
  // ⚠️ **总上限必须 ≥ 各段之和**，否则总账这一道永远在削、每步都留裁剪日志，
  //   而实际上"段上限"根本没有生效过 —— 测试有一条判据专门盯这个
  //   （「缺省总上限 ≥ 各段之和」）。第一版填 3000，而三段之和是 4400，
  //   当场被那条判据抓出来。
  //
  //   4500 = psyche 1200 + diary 2000 + tacit 1200 + 100 余量。
  //   真机满负荷实测三段很少同时满（日记只在压缩后带一次），实际约 2400。
  //
  // ⚠️ 2026-11-16 加 lifeline 段：total 4500 → 5800（+1300）。
  //   理由不是"预算松了"，而是这条的东西**结构和别的段不同**：
  //   lifeline 是**常驻时间骨架**（每月一句），它必须每天都在，
  //   而 diary 只在压缩后出现一次。把 lifeline 挤进原有 4500 里，
  //   等于让"少见的日记"占着"每天都在的索引"该用的位置 —— 那不划算。
  //   1300 的取法：60 个月 × 约 60 字符 ≈ 3600，但实际很少 5 年；
  //   按 18 个月 × 60 字符 + 标题 ≈ 1200，留 100 余量。
  //   超出的月份由 renderIndex 从**最近**往前丢，不会把整段撑爆。
  //
  // ⚠️ 2026-11-16 再加 ledger 段：total 5800 → 6700（+900）。
  //   但**这 900 不是常驻的**：ledger 只在压缩后（或首步）带一次，与 diary 同频。
  //   所以"每步都在烧的预算"实际只涨了 lifeline 那 1300。
  //   分清这两者很重要 —— 否则下次看数字会以为每步都多了 2200。
  budget: {
    total: 6700,
    psyche: 1200,
    tacit: 1200,
    diary: 2000,   // 压缩前日记的段上限（注入时只带最新一篇）
    lifeline: 1300, // 月度生命索引：常驻时间骨架（每月一句）
    ledger: 900,    // 工具结果账本：只在压缩后带一次

    // ── 事实索引化（已随 strand 段搬走）──
    //
    // ⚠️ 这个键现在归 dsh-strand 管（那边的 config.js 有同名项）。
    //   这里保留一个占位是为了让旧配置文件里的 `budget.factPreviewChars`
    //   仍能被 mergeKnown 接受而不报"未知键"，但它在本插件里**不生效**。
    factPreviewChars: 60,
  },

  // ── 压缩前日记（2026-11-05 主人指定）──
  //
  // ⚠️ 设计要点：**提前写，不拦截**。
  //   压缩由 dsh-compaction-basic 在它自己的 pre-step listener 里执行，
  //   而 listener 之间顺序无保证 —— 想"在压缩前一刻插一脚"是不可靠的承诺。
  //   所以策略是：压力到阈值就写（压缩阈值是 80%），等压缩真发生时日记早已在盘上。
  //
  // ⚠️ 为什么写磁盘而不是写上下文：上下文会被压缩遮蔽，磁盘不会。
  //   日记是压缩够不着的地方，也是压缩后重新长回来的种子。
  //
  // ⚠️ 阈值 0.7 → 0.62（2026-11-06 主人指定，实测调低）。
  //   原因：0.7 时真机**一次都没触发过**，日志里 `压力达阈值` 恒为 0 条。
  //   查出来是宿主那边先动手了：
  //     · compaction-basic 默认 thresholdRatio 0.8
  //     · 但 profile 装了 `context-lock`，把上下文上限锁在 406464 tokens
  //       （cordis.patch.yml:6 有算式：floor(min(W*0.8, W-O-65536))，O=128000）
  //   结果 406464 就先撞上了，dsh-mind 的 70%（≈420000）永远慢一步，
  //   每次都是"压缩发生后被动强写日记"，主动链路形同虚设。
  //   降到 0.62（≈372000）后，dsh-mind 抢在 context-lock 之前动手。
  diary: {
    enabled: true,
    pressureRatio: 0.62,     // 压力到多少就写（0.62 = 62%）
    contextWindow: 600000,   // 拿不到真实窗口时的回退值
    injectMaxChars: 2000,    // 注入时最多带多少字（只带最新一篇）
  },

  // ── 工具结果摘要层（2026-11-16 加，借鉴 VCP 白皮书 §4.7 的「五类 user 数组」）──
  //
  // ⚠️ 要解决的问题（本机 AGENTS.md「会话历史的体量纪律」早就记了同一个病）：
  //   实测构成里 `tool/result` 占 14%，而**单条 5 万字符的工具输出会永久留在历史里**，
  //   之后每一步都重读。目前靠"自律"（不 dump 整个文件）来压，
  //   但自律会失守 —— 忘了就是不记得了，没有任何结构性保障。
  //
  // VCP 的做法值得抄的是**分层**，不是它的具体参数：
  //   它把工具返回拆成 同步 / 异步 / 摘要 / 通知栏 / 元信息 五类，
  //   身份都是 user，但生命周期完全不同。最关键的是「摘要数组」：
  //   **只留时间戳和状态，Token 极低，长期保留**。
  //
  // ⚠️ 我抄的部分与不抄的部分（必须写清，否则后人以为我在照搬）：
  //   抄：给每条工具结果建立**一条常驻摘要记录**（工具名 + 是否成功 + 大小 + 一句话），
  //       让模型在原文被截断后仍知道「这一步做过什么」。
  //   不抄：改写宿主的消息数组结构。那是宿主的地盘（改坏了整条会话都坏），
  //        本插件只**记录**、不**篡改**对话。
  //
  // ⚠️ 为什么默认开但只做记录：记录是纯增量、零风险。
  //   真正的"替模型省上下文"必须由宿主支持，插件层越界改消息数组是本项目明确避开的。
  toolLedger: {
    enabled: true,
    maxEntries: 60,        // 每个会话最多留多少条（超出丢最老的）
    summaryMaxChars: 160,  // 每条摘要最多多少字符
    bigResultChars: 8000,  // 超过多少字符算「大结果」（只用于标注，不截断）
  },

  // ── 月度生命索引（2026-11-16 加，借鉴 VCP 白皮书 §9.5 的结构）──
  //
  // ⚠️ 它解决的问题（dsh-mind 原来缺的那一档）：
  //   日记只有最新一篇（2000 字符，压缩后带一次），存档要靠 mind_search 主动搜。
  //   中间断了一档：**一年前的经历既不在日记里，也不会想到去搜**。
  //   这一层把"每个月一句话"常驻，让模型不用先想到查就知道"有哪些月份、各是什么主题"。
  //
  // ⚠️ 为什么默认开：它是**只读 + 确定性归纳**，不调模型、不写别人的数据，
  //   最坏情况（索引文件坏了）也只是这一段空着，不影响其他段。
  //   按本文件顶部那条「缺配置就静默停摆是最难查的故障」，这类只读能力应当默认开。
  lifeline: {
    enabled: true,
    inject: true,
    maxChars: 1300,       // 常驻渲染上限（与 budget.lifeline 一致）
    rebuildEveryMs: 6 * 60 * 60 * 1000, // 至少隔 6 小时才重扫日记目录（避免每步 IO）
    relevantLimit: 2,     // 语境命中时最多提示几个月
  },

  // ── 压缩摘要用哪个模型（2026-11-12 补，之前是空的死开关）──
  //
  // ⚠️ 为什么必须在这里显式声明：`mergeKnown()` 只遍历 `Object.keys(defaults)`
  //   （见本文件末尾），所以**缺省里没有的键，写进 mind.json 也会被静默丢弃**。
  //   compaction.js 一直在读 `config.summarizationProvider`，但它从来拿不到值 ——
  //   这意味着「给压缩单独配模型」这个开关从上线起就是死的，没人发现，
  //   因为回退链（configured ?? latest ?? agentTarget）总能兜住，不报错。
  //
  // ⚠️ 空字符串 = 不指定，走回退链（最新已路由请求目标 → AgentOptions）。
  //   这两个键必须**成对**为空或非空，基类会校验（compaction-basic 的 configSchema）。
  summarizationProvider: '',
  summarizationModel: '',

  // ── 统一注入节奏 ──
  inject: {
    gapMs: 45000,     // 两次注入最小间隔
    fullEvery: 6,     // 每 N 次增量强制一次全量纠偏
  },

  tools: true,        // 注册 mind_* 工具
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * 逐层合并：只认缺省里已有的键，未知键忽略。
 *
 * ⚠️ 为什么未知键要忽略而不是照抄进去：
 *   旧配置里的键在升级后可能含义变了。照抄会让"我以为关掉了"变成"其实开着"。
 */
function mergeKnown(defaults, raw) {
  const out = Array.isArray(defaults) ? [...defaults] : { ...defaults }
  if (!isPlainObject(raw)) return out
  for (const k of Object.keys(defaults)) {
    const d = defaults[k]
    const r = raw[k]
    if (isPlainObject(d)) out[k] = mergeKnown(d, r)
    else if (typeof r === typeof d) out[k] = r
  }
  return out
}

export function readConfig() {
  let cfg = { ...DEFAULT_CONFIG }
  /**
   * 配置文件是否存在但读不出来（坏 JSON / 被截断）。
   *
   * ⚠️ 2026-11-17 修（隔离实测：坏 JSON 热加载把已关闭的 psyche 重新打开）。
   *
   * 原来的行为：解析失败 → 记一行日志 → `cfg = DEFAULT_CONFIG`（默认**全开**）→
   * 返回一个"完全正常"的配置对象。外层热加载看到返回值没有异常，
   * 于是替换 config 并打印「配置已热加载 :: enabled=true」——
   * 主人明确关掉的 psyche 就这样被一次**编辑器中间态**打开了。
   *
   * 这个标志让上层能区分"配置就是默认值"与"配置坏了，我只好退回默认值"。
   * 返回值仍是合法配置（插件要能继续跑），但**损坏事实**必须传到上层。
   */
  let corrupted = false
  let corruptReason = null

  // ① 主配置
  try {
    if (existsSync(CONFIG_PATH())) {
      // ⚠️ 2026-11-09 真机修：剥 BOM。Windows 工具（含女仆自己的 write 工具链）
      //   写 UTF-8 常带 EF BB BF，JSON.parse 直接抛 → 回退默认值 →
      //   主人的「全关」配置静默失效（psyche/strand 全被打开）。
      //   剥 BOM 是确定性的字节判断，不是语义猜测。
      const raw = readFileSync(CONFIG_PATH(), 'utf8').replace(/^﻿/, '')
      cfg = mergeKnown(DEFAULT_CONFIG, JSON.parse(raw))
    }
  } catch (e) {
    corrupted = true
    corruptReason = String(e?.message ?? e)
    log(`配置读取失败，已回退默认值（本次不会把回退值当作热加载成功） :: ${corruptReason}`)
    cfg = { ...DEFAULT_CONFIG }
  }
  // 把损坏事实挂成不可枚举属性：不改配置形状、不会被 JSON 序列化带出去，
  // 但上层（index.js 的热加载）能读到。
  Object.defineProperty(cfg, '__corrupted', { value: corrupted, enumerable: false })
  Object.defineProperty(cfg, '__corruptReason', { value: corruptReason, enumerable: false })

  // ② 旧的 psyche.json 兼容（若存在且主配置没写对应项）
  //
  // ⚠️ 只搬三个能一一对应的键，不整份照抄：
  //   旧文件的 `tools` 指的是"注册 psyche_* 工具"，新配置里 psyche 段已无此键，
  //   它对应的是顶层 tools。整份照抄会让它变成 psyche.tools（未知键被忽略），
  //   于是"关掉工具"这件事静默失效。
  try {
    const p = LEGACY_PSYCHE_CONFIG()
    if (existsSync(p)) {
      const old = JSON.parse(readFileSync(p, 'utf8'))
      const hasMain = existsSync(CONFIG_PATH())
      if (!hasMain) {
        if (typeof old?.enabled === 'boolean') cfg.enabled = old.enabled
        if (typeof old?.collectTools === 'boolean') cfg.psyche.collectTools = old.collectTools
        if (typeof old?.inject === 'boolean') cfg.psyche.inject = old.inject
        // ⚠️ 2026-11-08 拆分：`push` / `pushMax` 已搬到 dsh-strand，
        //   这里不再搬运 —— 搬进一个不存在的键会抛 TypeError。
        //   跨会话的开关由 dsh-strand 从 mind.json 的 strand 段读。
        if (typeof old?.gapMs === 'number') cfg.inject.gapMs = old.gapMs
        if (typeof old?.fullEvery === 'number') cfg.inject.fullEvery = old.fullEvery
        if (typeof old?.tools === 'boolean') cfg.tools = old.tools
        log('已从旧 psyche.json 迁移配置（建议改写成 ~/.dsh/mind.json）')
      }
    }
  } catch {
    /* 兼容路径失败不影响主配置 */
  }

  return cfg
}

/** 判断一份配置是不是"读坏了退回默认"的产物（见 readConfig 里的 corrupted）。 */
export function isCorrupted(cfg) {
  return cfg && cfg.__corrupted === true
}

export { CONFIG_PATH, mergeKnown }
