/**
 * dsh-mind · 基础设施：路径、日志、原子读写
 *
 * CCG 六要素:
 *   功能名   底层 I/O 与路径解析（三处旧插件各写过一遍的东西，收成一份）
 *   生效条件 所有 lib/*.js 都从这里拿路径与读写函数
 *   子功能   MIND_DIR 解析 / 追加日志（带轮转）/ 原子写 JSON / 安全读 JSON
 *   执行     全部用 Node 内置模块，零依赖
 *   验证方式 tests/regress.mjs 的路径一致性组（MIND_DIR 必须被 CLI、测试、插件一致解析）
 *   不适用条件 需要跨进程实时同步（那是网络，不是本模块）
 *
 * ⚠️ 为什么路径规则必须只有一处（2026-11-01 strand 的真实事故）：
 *   strand 时代 lib/index.js、strand-cli.mjs、selfcheck.mjs 三处各自写了一遍
 *   `process.env.STRAND_DIR || ~/.dsh/strand`，写法不统一的那次，CLI 读到了真实数据，
 *   而测试以为自己隔离成功了 —— 测试碰生产数据，绿得毫无意义。
 *   现在只留 MIND_DIR() 一个函数，谁要用谁调，不给"再写一遍"的机会。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  appendFileSync,
  statSync,
  unlinkSync,
  openSync,
  closeSync,
  fsyncSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID } from 'node:crypto'

// ─────────────────────────── 路径 ───────────────────────────

/**
 * 数据目录。
 *
 * 默认 `~/.dsh/mind`，可用 `MIND_DIR` 环境变量整体覆盖（测试用）。
 *
 * ⚠️ 必须用 `||` 而不是 `??`：空字符串要回退到默认值，
 *    否则 `MIND_DIR=""` 会让 GLOBAL_PATH 变成相对路径 `global.json`，
 *    静默写到当前工作目录去。
 */
export const MIND_DIR = () => process.env.MIND_DIR || join(homedir(), '.dsh', 'mind')

export const GLOBAL_PATH = () => join(MIND_DIR(), 'global.json')
export const STATE_PATH = () => join(MIND_DIR(), 'state.json')
export const LOG_PATH = () => join(MIND_DIR(), 'mind.log')
export const SESSIONS_DIR = () => join(MIND_DIR(), 'sessions')

/**
 * 经验库目录：**默认仍在旧位置**，那是主人手写的资产，不该跟着插件搬。
 *
 * ⚠️ 但默认值必须**跟着 MIND_DIR 走**（2026-11-06 修）：
 *   原来直接写死 `~/.dsh/tacit/experiences`，于是把 MIND_DIR 指到别处
 *   （测试、隔离实例、迁移后的新目录）时，**记忆数据隔离了，经验库没有** ——
 *   测试进程照样读到主人真实经验库，绿得毫无意义。
 *   这正是 io.js 开头那段注释里说的 strand 旧事故的翻版。
 *
 *   现在的推导：`dirname(MIND_DIR())/tacit/experiences`
 *     - 默认 MIND_DIR=~/.dsh/mind → ~/.dsh/tacit/experiences（**与原来完全一致**）
 *     - MIND_DIR=/tmp/x        → /tmp/tacit/experiences（真隔离）
 *   `MIND_EXPERIENCE_DIR` 仍然优先级最高，可单独指定。
 */
export const EXPERIENCE_DIR = () =>
  process.env.MIND_EXPERIENCE_DIR || join(dirname(MIND_DIR()), 'tacit', 'experiences')

/** 旧数据位置，仅迁移与兼容读取用。 */
export const LEGACY = {
  strandGlobal: () => join(homedir(), '.dsh', 'strand', 'global.json'),
  psycheSelf: () => join(homedir(), '.dsh', 'psyche', 'self.json'),
}

// ─────────────────────────── 日志 ───────────────────────────

const LOG_ROTATE_BYTES = 512 * 1024

/**
 * 追加一行日志。满了就轮转成 `.1` / `.2`，最多留两代。
 *
 * ## ⚠️ 为什么从「清空重来」改成「留两代」（2026-11-06）
 *
 * 原来一句 `writeFileSync(p, '', 'utf8')` 直接清空。理由是「日志只用于排查，
 * 备份反而堆没人看的旧文件」—— 听起来合理，实际吃过亏：
 *
 *   2026-11-06 查「为什么 70% 压缩一次没触发」，全靠 mind.log 里
 *   11:26 和 19:23 那两条历史记录对比 turn 字段才定位到根因。
 *   而当时 300 KB 已经贴着 512 KB 的线 —— 只要再跑一天就会被清空，
 *   那两条唯一的证据就没了。
 *
 * 日志是「事后取证」的唯一材料，清空等于把案发现场抹掉。
 * 两代 × 512 KB = 1 MB 封顶，成本可忽略，却能覆盖出问题前后的完整窗口。
 *
 * ⚠️ 日志失败绝不影响主流程：记忆注入挂掉不能带崩主人的对话。
 */
export function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}`
  try {
    mkdirSync(MIND_DIR(), { recursive: true })
    const p = LOG_PATH()
    if (existsSync(p) && statSync(p).size > LOG_ROTATE_BYTES) {
      // mind.log → mind.log.1 → mind.log.2（最老的丢）
      const p1 = p + '.1'
      const p2 = p + '.2'
      try {
        if (existsSync(p2)) unlinkSync(p2)
        if (existsSync(p1)) renameSync(p1, p2)
        renameSync(p, p1)
      } catch {
        // 轮转失败（文件被占用等）就退化成清空，至少不让日志无限涨
        writeFileSync(p, '', 'utf8')
      }
    }
    appendFileSync(p, stamped + '\n', 'utf8')
  } catch {
    /* 日志失败绝不影响主流程 */
  }
  return stamped
}

// ─────────────────────────── 原子读写 ───────────────────────────

/**
 * 原子写 JSON：先写临时文件 + fsync，再 rename。
 *
 * ⚠️ 为什么必须这样：
 *   多个窗口在同一进程里，但落盘仍可能被 SIGTERM / 崩溃打断。
 *   直接 writeFileSync 在 Windows 上不是原子操作，写一半会留下半截 JSON，
 *   下次启动读它直接抛异常。rename 在同一分区内是原子的。
 *
 * ⚠️ 2026-11-06 补两处（都不是理论问题）：
 *   ① **必须 fsync 再 rename**。writeFileSync 只是把数据交给操作系统页缓存，
 *      rename 只保证"目录项切换是原子的"，不保证内容已经落到盘上。
 *      断电/硬重启时会出现「文件名对、内容 0 字节」，readJson 静默返回 fallback ——
 *      表现就是**记忆凭空少了一截，且没有任何报错**。这是最坏的一种失败。
 *   ② **失败必须清掉临时文件**。原来 tmp 名带 pid + 8 位随机串，
 *      一旦 rename 或 write 抛错（Windows 上 rename 撞到杀软/占用很常见），
 *      那个半截 tmp 就永久留在 sessions/ 里，越积越多，还会被 sweepOrphans
 *      当成"来源不明的文件"报出来干扰排查。
 *      现在用 try/finally：**成功 rename 后 tmp 已经不存在，unlink 失败无害**。
 */
export function atomicWriteJson(path, data) {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`
  mkdirSync(dirname(path), { recursive: true })
  try {
    const body = JSON.stringify(data, null, 2)
    const fd = openSync(tmp, 'w')
    try {
      writeFileSync(fd, body, 'utf8')
      // fsync 失败不算致命（有些文件系统/网络盘不支持），但要走到 rename
      try {
        fsyncSync(fd)
      } catch {
        /* 不支持 fsync 就退化成纯 rename 语义 */
      }
    } finally {
      closeSync(fd)
    }
    renameSync(tmp, path)
  } catch (e) {
    // rename 之前的任何失败都必须清掉半截 tmp；rename 成功时它已不存在
    try {
      if (existsSync(tmp)) unlinkSync(tmp)
    } catch {
      /* 清不掉也不能让主流程炸 */
    }
    throw e
  }
}

/** 读 JSON；文件不存在或坏了返回 fallback，不抛。 */
export function readJson(path, fallback) {
  try {
    if (!existsSync(path)) return fallback
    const raw = readFileSync(path, 'utf8')
    if (!raw.trim()) return fallback
    return JSON.parse(raw)
  } catch {
    return fallback
  }
}

/**
 * 毫秒 → 「刚刚 / N 分钟前 / N 小时前」。
 *
 * ⚠️ 非数字输入必须显式说「未知时间」，不能让 NaN 漏到用户可见的文本里
 *   （2026-11-06 修）。原来只判 `!atMs`，于是：
 *     - `'abc'` / `NaN` / `{}` / 缺失字段 → `NaN 天前`
 *     - 传 **ISO 字符串**（state.json 里 injectedAt 就是字符串）→
 *       `now - '2026-11-06T…'` = NaN → 同样输出 `NaN 天前`
 *   而这段文本会直接进注入给模型看，「NaN 天前」既没用又像 bug。
 *   现在：数字只认有限值，数字字符串自动转，其他一律「未知时间」。
 */
export function agoText(atMs, now = Date.now()) {
  if (atMs === null || atMs === undefined || atMs === '') return '未知时间'
  let v = atMs
  if (typeof v === 'string') {
    // 纯数字字符串（'1730000000000'）转数字；ISO 时间串转时间戳
    v = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v)
  } else if (v instanceof Date) {
    v = v.getTime()
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return '未知时间'
  const d = Math.max(0, now - v)
  if (d < 30 * 1000) return '刚刚'
  if (d < 60 * 1000) return '不到一分钟前'
  const m = Math.floor(d / 60000)
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

/** 会话 id 的短形式，用于注入文本里指代某个窗口。 */
export function shortId(id, keep = 20) {
  const s = String(id ?? '')
  if (s.startsWith('session-')) {
    const body = s.slice(8)
    return body.length > keep ? `${body.slice(0, keep)}…` : body
  }
  return s.length > keep ? `${s.slice(0, keep)}…` : s
}

/** 压成一行并截断。所有进状态的文本都走这里，保证体积可控。 */
export function oneLine(s, max = 100) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t
}
