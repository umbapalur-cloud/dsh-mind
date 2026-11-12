/**
 * dsh-mind · 可逆摘要（collapse archive）
 *
 * CCG 六要素:
 *   功能名   压缩前把被折叠区间**原文落盘**，摘要里留句柄，之后可按 seq 取回
 *   生效条件 compaction.js 的 summarize() 调用 archiveRegion()
 *   子功能   落盘 / 列句柄 / 按区间还原 / 清理
 *   执行     archiveRegion() · expandRegion() · listArchives()
 *   验证方式 tests/regress.mjs 第 57 组
 *   不适用条件 不负责摘要怎么写（那是 compaction.js），也不管压缩何时触发（那是基类）
 *
 * ⚠️ 为什么需要它（2026-11-05，读 billion-context 后加的）：
 *   DSH 原生压缩是**单向门**：`commitCompactionBody` 用
 *     `surfaceOp: { op:'replace', startSeq, endSeq }`
 *   把原文从表层遮蔽掉，只留下摘要。原文还在 session.v4.jsonl.zstd 里，
 *   但**没有任何工具能取回**，而且它随会话滚雪球、迟早被 GC 掉。
 *
 *   对照 billion-context 的做法：它给模型一个 `decompress` 工具，
 *   能把一段折叠过的范围还原。它的 README 原话：
 *     「摘要在小范围内写入，**可按需解压**，缓存前缀保持完整。」
 *
 *   女仆这边不需要那么重（不必装代理），只需要补上「记着原文在哪」这一块：
 *   压缩发生时把被遮蔽的区间写成独立文件 + 在摘要末尾附一份**索引**。
 *   这样压缩就从「销毁」变成「降采样」。
 *
 * ⚠️ 为什么单独落盘而不是靠会话日志：
 *   ① 会话日志是多帧 zstd，读一次要逐帧解压（本项目已踩过坑：
 *      `zstdDecompressSync` 只解第一帧，扫 150 个会话得出"0 次压缩"的假阴性）
 *   ② 日志会被宿主清理、会随压缩反复重写
 *   ③ 存档要能被**另一个会话**读到 —— 这才是"不死"的意义
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { MIND_DIR } from './io.js'

/**
 * 存档落点：和 mind 其他数据同根（`MIND_DIR`），子目录 `archives/`。
 *
 * ⚠️ 2026-11-05 修的真 bug：第一版这里**自己拼了一套路径**：
 *     const home = process.env.DSH_HOME || join(homedir(), '.dsh')
 *     return join(home, 'mind', 'archives')
 *
 *   看起来等价，实际是**第二套真相**：它只认 `DSH_HOME`，不认 `MIND_DIR`。
 *   而全项目的隔离（包括 tests/regress.mjs 第 15-17 行）都是靠 `MIND_DIR` 做的。
 *
 *   血证：跑一次回归，真机目录 `$HOME/.dsh/mind/archives/` 里
 *   多出 `s-arch__10-13.json` 和 `s-big__30-30.json`（测试造的假会话）。
 *   后果不只是脏：将来真存档和测试垃圾混在一起，`mind_expand` 会取回
 *   **假原文**，那比取不到更糟 —— 模型会把「9000 个 Z」当成当时的对话。
 *
 *   现在统一走 `MIND_DIR()`：测试给 `MIND_DIR=<临时目录>` 时，存档自然落在临时目录，
 *   测试跑完随 `rmSync` 一起消失，真机目录永远干净。
 */
export function ARCHIVE_DIR() {
  return join(MIND_DIR(), 'archives')
}

/** 单个存档文件的上限（防一次压缩把磁盘打满）。超出则只存前 N 条并标注截断。 */
export const MAX_ARCHIVE_BYTES = 2 * 1024 * 1024

/** 单个区间里最多还原多少字符（防一次 expand 把上下文撑爆）。 */
export const MAX_EXPAND_CHARS = 60000

function safeName(s) {
  return String(s).replace(/[^a-zA-Z0-9._-]/g, '_')
}

/** seq 区间 → 稳定文件名。 */
export function archivePath(sessionId, startSeq, endSeq) {
  return join(ARCHIVE_DIR(), `${safeName(sessionId)}__${startSeq}-${endSeq}.json`)
}

/**
 * 从一条事件里抽出可读文本。
 *
 * ⚠️ 只取**内容**，不取 data.stream（那是流式增量，占会话 77%，全是噪声）。
 *   宿主写日志时 data.stream 是逐 token 的，存档它等于存了十几份重复内容。
 *
 * ⚠️ 2026-11-05 真机端到端抓到的 bug：第一版 blocksToText 只认 `type === 'text'`，
 *   其余块一律返回空串。后果是**工具调用整段丢失** ——
 *   真机一次压缩的 497 个 seq 里有 88 条 assistant/message，
 *   内容形如 `[{type:'reasoning'},{type:'tool-call',name:'read',arguments:'...'}]`，
 *   一个 text 块都没有 → 全被过滤 → 这 88 条既不进存档、也不报错。
 *   更糟的是 `reasoning` 块里往往有"上一版参数写错了，改成 X"这类推理过程，
 *   那是原文里最有价值的部分，丢了等于存档看着完整、实际缺关键环节。
 *
 *   现在 text / reasoning / tool-call / tool-result / image 全部保留，各自带标注。
 */
function textOfEvent(ev) {
  const d = ev?.data
  if (!d) return ''

  // 用户/助手消息：data.content 或 data.message.content
  const content = d.content ?? d.message?.content
  if (content !== undefined) {
    const t = blocksToText(content)
    // 工具调用也可能是独立事件（不在 message.content 里）
    if (t) return t
  }

  // 工具调用（事件级）
  if (ev.type === 'tool/call') {
    return toolCallText(d)
  }
  // 工具结果（事件级）
  if (ev.type === 'tool/result') {
    const r = d.result ?? d.output ?? d.content
    const body = r === undefined ? '' : typeof r === 'string' ? r : JSON.stringify(r)
    return `[tool/result] ${body}`
  }
  return ''
}

/** 把一条工具调用渲染成可读文本（含参数，便于以后照原样复现）。 */
function toolCallText(b) {
  const name = b.name ?? b.toolName ?? '?'
  const args = b.arguments ?? b.args
  return `[tool/call] ${name} ${args === undefined ? '' : typeof args === 'string' ? args : JSON.stringify(args)}`
}

/**
 * 内容块数组 → 纯文本。
 *
 * 每种块都带标注前缀，这样以后 `mind_expand` 取回时，
 * 模型能分清哪句是女仆当时说的、哪句是工具的原始输出。
 */
function blocksToText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (content && typeof content === 'object' && typeof content.text === 'string') return content.text
    return ''
  }
  return content
    .map((b) => {
      if (typeof b === 'string') return b
      switch (b?.type) {
        case 'text':
          return b.text ?? ''
        case 'reasoning':
          // 推理过程也是原文的一部分。用标注隔开，免得和正式回答混淆。
          return b.text ? `[思考] ${b.text}` : ''
        case 'tool-call':
          return toolCallText(b)
        case 'tool-result':
          return `[tool/result] ${
            typeof b.result === 'string' ? b.result : JSON.stringify(b.result ?? b.content ?? b.output ?? '')
          }`
        case 'image':
          return '[图片]'
        default:
          // ⚠️ 未知块类型不能静默丢 —— 至少留个标记，
          //   否则以后想看"当时到底有什么"会得到一份看似完整、实则缺项的记录。
          return `[${b?.type ?? '未知块'}] ${b?.text ?? ''}`.trim()
      }
    })
    .filter(Boolean)
    .join('\n')
}

/**
 * 把一次压缩的区间原文落盘。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {number[]} opts.seqs        被遮蔽的 seq 列表（基类的 shadowedSeqs）
 * @param {Function} opts.eventAt     seq → 事件
 * @returns {{path:string,startSeq:number,endSeq:number,entries:number,bytes:number,truncated:boolean}|null}
 */
export function archiveRegion({ sessionId, seqs, eventAt }) {
  if (!sessionId || !Array.isArray(seqs) || seqs.length === 0) return null
  if (typeof eventAt !== 'function') return null

  const entries = []
  let bytes = 0
  let truncated = false

  for (const seq of seqs) {
    let ev
    try {
      ev = eventAt(seq)
    } catch {
      continue
    }
    if (!ev) continue
    const text = textOfEvent(ev)
    if (!text) continue

    const entry = { seq, type: ev.type, time: ev.time ?? null, text }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (bytes + size > MAX_ARCHIVE_BYTES) {
      truncated = true
      break
    }
    bytes += size
    entries.push(entry)
  }

  if (entries.length === 0) return null

  const startSeq = Math.min(...entries.map((e) => e.seq))
  const endSeq = Math.max(...entries.map((e) => e.seq))
  const path = archivePath(sessionId, startSeq, endSeq)
  const record = {
    version: 1,
    sessionId,
    startSeq,
    endSeq,
    archivedAt: new Date().toISOString(),
    entries: entries.length,
    bytes,
    truncated,
    items: entries,
  }

  try {
    mkdirSync(ARCHIVE_DIR(), { recursive: true })
    writeFileSync(path, JSON.stringify(record), 'utf8')
  } catch {
    return null // 存档失败绝不能影响压缩本身
  }

  return { path, startSeq, endSeq, entries: entries.length, bytes, truncated }
}

/** 列出某个会话的全部存档（按 startSeq 升序）。 */
export function listArchives(sessionId) {
  const dir = ARCHIVE_DIR()
  if (!existsSync(dir)) return []
  const prefix = sessionId ? `${safeName(sessionId)}__` : ''
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    if (prefix && !f.startsWith(prefix)) continue
    const p = join(dir, f)
    try {
      const st = statSync(p)
      out.push({ file: f, path: p, bytes: st.size, mtime: st.mtimeMs })
    } catch {
      // 读不到就跳过，不抛
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file))
}

/**
 * 取回某个区间的原文。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {number} [opts.seq]       要还原的具体 seq
 * @param {number} [opts.fromSeq]   区间起点
 * @param {number} [opts.toSeq]     区间终点
 * @param {number} [opts.maxChars]
 * @returns {{text:string,hit:boolean,source:string,range:string,chars:number,truncated:boolean}}
 */
export function expandRegion({ sessionId, seq, fromSeq, toSeq, maxChars = MAX_EXPAND_CHARS }) {
  const lo = Number.isFinite(fromSeq) ? fromSeq : Number.isFinite(seq) ? seq : null
  const hi = Number.isFinite(toSeq) ? toSeq : Number.isFinite(seq) ? seq : null
  if (lo === null || hi === null) {
    return { text: '', hit: false, source: 'none', range: '', chars: 0, truncated: false }
  }

  const files = listArchives(sessionId)
  const picked = []
  for (const f of files) {
    let rec
    try {
      rec = JSON.parse(readFileSync(f.path, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(rec.items)) continue
    // 区间有交集就取
    if (rec.endSeq < lo || rec.startSeq > hi) continue
    for (const it of rec.items) {
      if (it.seq >= lo && it.seq <= hi) picked.push(it)
    }
  }

  if (picked.length === 0) {
    return { text: '', hit: false, source: 'none', range: `${lo}..${hi}`, chars: 0, truncated: false }
  }

  picked.sort((a, b) => a.seq - b.seq)
  const parts = []
  let chars = 0
  let truncated = false
  for (const it of picked) {
    const head = `── seq ${it.seq} [${it.type}] ──\n`
    const line = head + it.text

    // ⚠️ 单条就超限时必须**截断这一条**，而不是 break 跳过。
    //   第一版写的是「超了就 break」，端到端实测立刻暴露：
    //   真实会话里单条消息动辄上万字符，maxChars=3000 时
    //   第一条就超 → break → **返回 hit:true 但 text 是空字符串**。
    //   模型会以为"取到了但没内容"，比明确说"没取到"更糟。
    if (line.length > maxChars) {
      if (parts.length === 0) {
        // 至少给出这一条的开头，让模型知道取到了什么
        parts.push(head + String(it.text).slice(0, Math.max(0, maxChars - head.length)) + '\n…（本条被截断）')
        chars = maxChars
      }
      truncated = true
      break
    }

    if (chars + line.length > maxChars) {
      truncated = true
      break
    }
    chars += line.length
    parts.push(line)
  }

  return {
    text: parts.join('\n\n'),
    hit: true,
    source: 'archives',
    range: `${lo}..${hi}`,
    chars,
    truncated,
  }
}

/**
 * 在被压缩掉的存档里**按关键词搜索**。
 *
 * ## 为什么需要它（2026-11-06 加，思路借鉴 billion-context 的 search_context）
 *
 * 压缩之后最深的问题不是"取不回来"，而是**不知道自己要取什么**。
 *   · `mind_expand` 要**先知道 seq 区间** —— 可女仆丢了上下文后根本不知道 seq。
 *   · 不知道自己不知道，才是记忆系统真正的坑。
 *
 * 有了这个之后：想得起关键词 → 搜 → 拿到 seq → 再 `mind_expand` 取全文。
 *
 * ## 与 billion-context 的差别（不照抄的地方）
 *
 *   · 它是**跨压缩块做词法匹配**；这里直接扫 archives/ 的原文条目，更简单。
 *   · 它返回 ref span（m00044–m00097）；这里返回**真实 seq**，可直接喂给 mind_expand。
 *   · 它默认 planAware=false，输出「byte-identical lexical」；这里同样**纯词法、可复现**，
 *     不做任何语义排序 —— 排序靠命中次数与位置，规则写死，不猜意图。
 *
 * ## 匹配规则（写死，可预测）
 *
 *   ① 多个词用空格分开 = **全部都要出现**（AND），不区分大小写。
 *   ② 中文不切词，按**子串**匹配（中文没有空格，切词反而错）。
 *   ③ 排序：命中词数多的在前，同分按 seq 升序（时间顺序，便于顺着看）。
 *   ④ 只返回**摘要行**（前 N 字符），不返回全文 —— 全文要另调 mind_expand，
 *      这样搜索本身不烧预算。
 *
 * @param {object} opts
 * @param {string} opts.sessionId
 * @param {string} opts.query          关键词，空格分隔多个（全都要命中）
 * @param {number} [opts.limit=10]     最多返回几条
 * @param {number} [opts.ctxChars=120] 每条预览多少字符
 * @returns {{ok:boolean, hits:Array, scanned:number, files:number, error?:string}}
 */
export function searchArchives({ sessionId, query, limit = 10, ctxChars = 120 }) {
  const q = String(query ?? '').trim()
  if (!q) return { ok: false, error: 'query 不能为空', hits: [], scanned: 0, files: 0 }

  // 空格分隔 → AND；转小写做不区分大小写匹配。
  // ⚠️ 中文不切词：'压缩日记' 会整体当一个词去子串匹配，这是对的。
  const terms = q
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter(Boolean)
  if (terms.length === 0) return { ok: false, error: 'query 不能为空', hits: [], scanned: 0, files: 0 }

  const files = listArchives(sessionId)
  const hits = []
  let scanned = 0

  for (const f of files) {
    let rec
    try {
      rec = JSON.parse(readFileSync(f.path, 'utf8'))
    } catch {
      continue
    }
    if (!Array.isArray(rec.items)) continue

    for (const it of rec.items) {
      scanned++
      const text = String(it.text ?? '')
      const lower = text.toLowerCase()
      let matched = 0
      let firstAt = -1
      for (const t of terms) {
        const at = lower.indexOf(t)
        if (at < 0) {
          matched = -1
          break
        }
        matched++
        if (firstAt < 0 || at < firstAt) firstAt = at
      }
      if (matched < 0) continue

      // 预览：从**第一个命中的位置**往前留一点上下文，让命中词出现在行里，
      // 而不是从条目开头截 —— 否则搜到了却看不见搜的那个词。
      const start = Math.max(0, firstAt - Math.floor(ctxChars / 3))
      const preview = text.slice(start, start + ctxChars).replace(/\s+/g, ' ').trim()
      hits.push({
        seq: it.seq,
        type: it.type,
        time: it.time ?? null,
        matched,
        preview: (start > 0 ? '…' : '') + preview + (start + ctxChars < text.length ? '…' : ''),
        chars: text.length,
      })
    }
  }

  // 命中多的在前；同分按 seq 升序（时间顺序）
  hits.sort((a, b) => b.matched - a.matched || a.seq - b.seq)

  return {
    ok: true,
    query: q,
    terms,
    hits: hits.slice(0, Math.max(1, limit)),
    total: hits.length,
    scanned,
    files: files.length,
  }
}

/** 给摘要末尾附的索引。没有存档时返回空串（不占预算）。 */
export function archiveIndexText(sessionId, limit = 8) {
  const files = listArchives(sessionId)
  if (files.length === 0) return ''

  const rows = []
  for (const f of files.slice(-limit)) {
    const m = /__(\d+)-(\d+)\.json$/.exec(f.file)
    if (!m) continue
    rows.push(`- seq ${m[1]}..${m[2]}（${Math.round(f.bytes / 1024)} KB，原文已存档）`)
  }
  if (rows.length === 0) return ''

  return [
    '## 已折叠区间（原文可还原）',
    '下面的区间被压缩遮蔽了，但**原文已落盘**。需要精确细节时用 `mind_expand <sessionId> <from>..<to>` 取回，不要凭摘要猜。',
    ...rows,
  ].join('\n')
}

/**
 * 清理孤儿存档。
 *
 * ⚠️ 默认只做「报告」不做删除（dryRun:true）。
 *   存档是记忆的备份，静默删除属于不可接受的破坏 —— 必须由调用方显式决定。
 */
export function sweepArchives({ keepSessions = null, maxAgeDays = 90, dryRun = true, now = Date.now() } = {}) {
  const files = listArchives(null)
  const stale = []
  for (const f of files) {
    const m = /^(.+?)__\d+-\d+\.json$/.exec(f.file)
    const sess = m ? m[1] : null
    if (keepSessions && sess && keepSessions.has(sess)) continue
    const ageDays = (now - f.mtime) / 86400000
    if (ageDays <= maxAgeDays) continue
    stale.push(f)
  }
  if (!dryRun) {
    for (const f of stale) {
      try {
        unlinkSync(f.path)
      } catch {
        // 删不掉就留着
      }
    }
  }
  return { candidates: stale.map((f) => f.path), deleted: dryRun ? 0 : stale.length, dryRun }
}
