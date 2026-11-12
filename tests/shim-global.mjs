// dsh-mind 测试专用垫片：为「已搬到 dsh-strand」的符号提供**只在本进程内**的替身。
//
// ⚠️ 为什么用垫片而不是把 800 行调用点全删掉（2026-11-08 拆分时定）
//
//   测试里有 130+ 处 `global.rememberFact(...)` / `strandSeg.render(...)`。
//   那些调用点分布在 **54 个还活着的组**里（测 psyche / tacit / 压缩 / 日记的），
//   它们用跨会话数据只是**当输入数据**，并不测跨会话功能本身。
//   如果一个个删，就要改 54 个组的上下文，改错一处就是假绿/假红。
//
//   更干净的做法：垫片提供**形状相同**的替身，数据存在内存里。
//     · 测跨会话功能的组已经整体删掉了（它们在新插件里有 214 项）
//     · 留下的组照旧跑，它们看到的"共享层"是这个内存版
//     · **关键**：垫片绝不写盘、绝不读 `~/.dsh/mind/global.json`
//       —— 不会污染主人真实数据，也不会把真实的 72 条事实灌进测试
//
// ⚠️ 垫片与真实现的差异必须清楚（不然测试会验出假东西）：
//   · 没有文件持久化 → "并发写不丢" "迁移" 这类组已经删了（它们测的就是落盘）
//   · 没有配额裁剪的完整逻辑 → 配额组已删
//   · 指纹只用内存内容算 → 但**语义保持一致**（同 key 覆盖、stale 进指纹）
//
//   一句话：垫片保的是"**形状与语义**"，不保"**磁盘行为**"。
//   磁盘行为在 dsh-strand 里被 214 项盯着。

/** 内存共享层。每次 resetAll() 清空。 */
let state = emptyState()

function emptyState() {
  return { version: 2, updatedAt: new Date().toISOString(), facts: [], timeline: [], threads: [] }
}

export function resetAll() {
  state = emptyState()
  migrated = false
}

export function emptyGlobal() {
  return emptyState()
}

export function readGlobal() {
  return { ...state, facts: [...state.facts], timeline: [...state.timeline], threads: [...state.threads] }
}

export const MAX_FACTS = 120
export const MAX_TIMELINE = 60
export const MAX_THREADS = 40
export const TIMELINE_QUOTA_USER = 28
export const TIMELINE_QUOTA_ASSISTANT = 12
export const REPLY_MAX_CHARS = 120
export const REPLY_MAX_PER_TURN = 1
export const CAPTURE_MAX_CHARS = 160

export function rememberFact(key, value, from, opts = {}) {
  const k = String(key ?? '').trim()
  const v = String(value ?? '').replace(/\s+/g, ' ').trim()
  const now = new Date().toISOString()
  const entry = { key: k, value: v, at: now, from: from ?? 'unknown' }
  if (opts.stale === true) entry.stale = { at: now, by: from ?? 'unknown', reason: 'explicit' }

  const i = state.facts.findIndex((f) => f.key === k)
  if (i >= 0) state.facts[i] = entry
  else state.facts.push(entry)

  const superseded = []
  if (Array.isArray(opts.supersedes)) {
    for (const oldKey of opts.supersedes) {
      const j = state.facts.findIndex((f) => f.key === oldKey)
      if (j < 0 || state.facts[j].key === k) continue
      state.facts[j].stale = { at: now, by: k, reason: 'superseded' }
      superseded.push(oldKey)
    }
  }
  if (state.facts.length > MAX_FACTS) state.facts = state.facts.slice(-MAX_FACTS)
  state.lastFactAt = now
  return { ...entry, _superseded: superseded }
}

export function forgetFact(key, opts = {}) {
  const onlyStale = opts.onlyStale !== false
  const k = String(key ?? '').trim()
  if (!k) return { ok: false, error: 'key 不能为空' }
  const i = state.facts.findIndex((f) => f.key === k)
  if (i < 0) return { ok: false, error: `没找到 key=${k}` }
  if (onlyStale && !state.facts[i].stale) {
    return { ok: false, error: `key=${k} 仍有效，拒绝删除。确实要删有效事实时显式传 onlyStale:false` }
  }
  const [removed] = state.facts.splice(i, 1)
  return { ok: true, removed: { key: removed.key, at: removed.at, wasStale: !!removed.stale }, noteRemoved: false, remaining: state.facts.length }
}

export function activeFacts(g = readGlobal()) {
  return g.facts.filter((f) => !f.stale)
}

export function staleFacts(g = readGlobal()) {
  return g.facts.filter((f) => f.stale)
}

export function appendTimeline(session, text, by = 'auto') {
  const entry = {
    at: new Date().toISOString(),
    session: String(session ?? '?'),
    text: String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
    by,
  }
  const last = state.timeline[state.timeline.length - 1]
  if (last && last.session === entry.session && last.text === entry.text) return entry
  state.timeline.push(entry)
  if (state.timeline.length > MAX_TIMELINE) state.timeline = state.timeline.slice(-MAX_TIMELINE)
  state.lastTimelineAt = entry.at
  return entry
}

export function addThread(text, from) {
  const entry = { id: `t${Math.random().toString(36).slice(2, 8)}`, text: String(text ?? '').slice(0, 240), at: new Date().toISOString(), from: from ?? 'unknown' }
  state.threads.push(entry)
  if (state.threads.length > MAX_THREADS) state.threads = state.threads.slice(-MAX_THREADS)
  return entry
}

export function closeThread(idOrMatch) {
  const key = String(idOrMatch ?? '').trim()
  if (!key) return null
  const i = state.threads.findIndex((t) => t.id === key || t.text.includes(key))
  if (i < 0) return null
  const [entry] = state.threads.splice(i, 1)
  return entry
}

/**
 * 指纹：**语义与真实现一致**（同 key 覆盖、stale 进哈希），
 * 只是不算 `lastFactAt` 的时间戳 —— 测试里那会让"同 key 同值重写"永远判成变化。
 */
export function globalFingerprint() {
  const sig = () => {
    let h = 0x811c9dc5
    for (const f of state.facts) {
      const s = f.key + '=' + f.value + (f.stale ? '!S' : '')
      for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193) >>> 0
      }
    }
    return h.toString(36)
  }
  return [state.facts.length, sig(), state.timeline.length, state.threads.length].join('|')
}

// 迁移相关：垫片永远说"已经处理过"，避免测试去碰真实目录
let migrated = true
export function _migrateGuard() {
  return migrated
}

// ⚠️ 显式声明：垫片不落盘。有测试想验"写盘"的话，它必须去 dsh-strand。
export const PERSISTS_TO_DISK = false
