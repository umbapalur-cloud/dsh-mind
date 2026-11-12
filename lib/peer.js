/**
 * dsh-mind · 对端数据（软依赖）：只读 dsh-strand 的共享层
 *
 * CCG 六要素:
 *   功能名   在写压缩前日记时，尽力读一份跨会话的 facts/timeline 摘录
 *   生效条件 dsh-strand 已安装且数据目录里有 global.json
 *   子功能   readPeerGlobal() → { facts, timeline, threads, available }
 *   执行     **直接读对方的 JSON 文件**，不 import 对方的任何模块
 *   验证方式 tests/regress.mjs 的对端软依赖组（有文件/无文件/坏文件三种）
 *   不适用条件 需要读写对方的运行状态（那是对方的事，本模块只读盘）
 *
 * ⚠️⚠️ 为什么是"读文件"而不是 `import 'dsh-strand/lib/global.js'`（2026-11-08 主人要求拆分时定）
 *
 *   主人的要求是两个插件**各自独立**。import 会带来三种耦合，每一种都会让
 *   "拆分"变成假拆分：
 *
 *   ① **卸载即崩**：dsh-strand 被卸载/改名 → 模块解析失败 → dsh-mind 整个
 *      import 链断掉 → 自我觉知、经验库、压缩日记、压缩引擎全挂。
 *      主人拆分的初衷是"一个坏了另一个还能活"，import 直接违背它。
 *
 *   ② **版本锁死**：对方改一个导出名，这边就报 `does not provide an export named`。
 *      而这种错误发生在 **import 阶段**，try/catch 包在函数里根本接不住。
 *
 *   ③ **循环依赖**：对方的 `SELF_SOURCE_KINDS` 又要认识本插件的 kind
 *      （防自我放大），两边互相 import 就是环。
 *
 *   读 JSON 文件把这三样全解决了：
 *     · 文件不存在 → 返回空，本插件照常跑（**降级而非崩溃**）
 *     · 对方改内部结构 → 这边只认 `facts` / `timeline` 两个数组，多出来的键忽略
 *     · 没有 import 就没有环
 *
 * ⚠️ 这是**有代价的交换，必须说清**：
 *   ① 对方的数据结构变了，这边读到的可能不全（所以每个字段都要 defensive 校验）；
 *   ② 本插件不知道对方的开关状态 —— 对方关掉了，日记里仍然会有那份摘录。
 *      这可以接受：日记是给"压缩后的自己"的参考，多一份旧数据比丢一份强。
 *
 * ⚠️ 路径解析必须认对方的 `STRAND_DIR` 环境变量（测试隔离用），
 *   否则测试里会把主人在用的真实共享层读进来 ——
 *   那是 strand 时代栽过的"测试碰生产数据"同一个坑。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { log } from './io.js'
import { MIND_DIR } from './io.js'

/**
 * 对端（dsh-strand）的数据目录。
 *
 * ⚠️ 三条来源按优先级：
 *   ① `STRAND_DIR` 环境变量 —— 测试隔离、用户自定义
 *   ② 与本插件**同级**的 `strand` 目录（默认 `~/.dsh/strand`）
 *      这样 `MIND_DIR` 被指到临时目录时，对方也跟着到临时目录的同级，
 *      测试天然隔离（与 io.js 的 EXPERIENCE_DIR 同一套推导）
 *   ③ homedir 兜底
 */
export const PEER_DIR = () =>
  process.env.STRAND_DIR || join(dirname(MIND_DIR()), 'strand')

export const PEER_GLOBAL_PATH = () => join(PEER_DIR(), 'global.json')

/** 空的共享层形状。**永远返回同一种结构**，调用方不用判空。 */
function empty() {
  return { available: false, facts: [], timeline: [], threads: [], reason: 'not-found' }
}

/**
 * 读对端共享层。
 *
 * ⚠️ 绝不抛：这是"有就读、没有就算"的附加信息，读失败不能影响日记本身。
 * ⚠️ 坏文件返回 available=false 并留痕：静默返回空会让"对方数据坏了"
 *   看起来像"对方还没写数据"，两种情况的处理方式完全不同。
 */
export function readPeerGlobal() {
  try {
    const p = PEER_GLOBAL_PATH()
    if (!existsSync(p)) return empty()

    const raw = readFileSync(p, 'utf8')
    if (!raw.trim()) return { ...empty(), reason: 'empty' }

    const g = JSON.parse(raw.replace(/^\uFEFF/, '')) // 容忍 BOM（Windows 常见）
    if (!g || typeof g !== 'object') return { ...empty(), reason: 'bad-shape' }

    return {
      available: true,
      facts: Array.isArray(g.facts) ? g.facts : [],
      timeline: Array.isArray(g.timeline) ? g.timeline : [],
      threads: Array.isArray(g.threads) ? g.threads : [],
    }
  } catch (e) {
    log(`对端共享层读取失败（日记里这一段留空） :: ${e?.message ?? e}`)
    return { ...empty(), reason: `error:${e?.name ?? 'Error'}` }
  }
}

/**
 * 给日记用的摘录：只取**与压缩后最相关**的那部分。
 *
 * ⚠️ 为什么不整段倒进去：日记要跟着注入进上下文（injectMaxChars 上限 2000），
 *   72 条事实全塞进去会把真正重要的「已作废结论」「未结线索」挤掉。
 *   这里只取最近若干条，且**由调用方决定条数**（它在预算那边）。
 */
export function peerDigest({ facts = 30, timeline = 20 } = {}) {
  const p = readPeerGlobal()
  if (!p.available) return { available: false, facts: [], timeline: [] }
  return {
    available: true,
    facts: p.facts.slice(-facts),
    timeline: p.timeline.slice(-timeline),
  }
}
