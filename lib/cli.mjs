#!/usr/bin/env node
/**
 * mind-cli —— dsh-mind 命令行入口（另一个进程，与宿主共用同一份数据文件）
 *
 * 用法:
 *   node lib/cli.mjs experiences              列出经验库条目
 *   node lib/cli.mjs sessions                 列出登记过的窗口
 *   node lib/cli.mjs log [n]                  看最近 n 行日志
 *   node lib/cli.mjs path                     打印数据目录
 *
 * ⚠️ 2026-11-08 拆分：跨会话那批命令（remember / note / thread / close /
 *   show / stale / restore / forget）**整体搬到 strand-cli**。
 *
 *   为什么必须删而不是留着报错：它们 import 的 `./global.js` 已随 facts
 *   一起搬到 dsh-strand，文件不在了。ESM 的 import 在**模块链接阶段**就解析，
 *   所以整个 cli.mjs 会在 `Cannot find module .../global.js` 处直接退出 ——
 *   连 `path`、`log`、`sessions` 这些跟跨会话毫无关系的命令也一起用不了。
 *   实测：`node lib/cli.mjs path` → exit=1 + ERR_MODULE_NOT_FOUND。
 *
 *   这也解释了为什么测试没抓到：regress.mjs 只做了**文本级**判据
 *   （检查源码里有没有「取主目录」这类调用、有没有从 io.js 导入），
 *   从来没真的 spawn 过它。文本里有那行 import 不代表能跑起来。
 *   ⚠️ 2026-11-08 已补第 39 组「CLI 真能跑」：真的 spawn 一次并检查退出码，
 *      光看文本的判据已被证明挡不住 import 阶段的错误。
 *
 *   ⚠️ 跨会话数据请用 `strand-cli`（在 dsh-strand 里，命令集见它的 usage）。
 *
 * ⚠️ 为什么 CLI 要单独存在（而不是只靠工具）：
 *   模型在会话里当然能用 mind_* 工具，但主人自己在终端里想看一眼状态时，
 *   不该需要先开一个会话。
 *
 * ⚠️ 路径解析必须与插件完全一致 —— 全部走 lib/io.js，不在这里再写一遍。
 *   2026-11-01 strand 时代三处写法不统一，CLI 读到了真实数据而测试以为隔离成功。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { MIND_DIR, LOG_PATH, EXPERIENCE_DIR, shortId } from './io.js'
import { loadExperiences } from './segments/tacit.js'

const argv = process.argv.slice(2)
const cmd = argv[0]

function out(obj) {
  process.stdout.write(typeof obj === 'string' ? obj + '\n' : JSON.stringify(obj, null, 2) + '\n')
}

function usage() {
  out(`mind-cli —— dsh-mind 命令行（本插件的状态与经验）

  experiences              列出经验库条目
  sessions                 列出登记过的窗口
  log [n]                  看最近 n 行日志（默认 30）
  path                     打印数据目录

  ⚠️ 跨会话记忆（facts / timeline / threads）已搬到另一个插件，
     请用 strand-cli：
       remember <key> <value>   记一条事实
       note <text>              追加一条动向
       thread <text>            挂一条未结线索
       close <id或文本>          结掉一条未结线索
       show [facts|timeline|threads|all]
       stale / restore / forget
       log / path

数据目录: ${MIND_DIR()}
环境变量 MIND_DIR 可整体覆盖。`)
}

switch (cmd) {
  case 'experiences': {
    const items = loadExperiences()
    out({
      ok: true,
      dir: EXPERIENCE_DIR(),
      count: items.length,
      items: items.map((e) => ({ id: e.id, trigger: e.trigger, condition: e.condition, trust: e.trust, title: e.title })),
    })
    break
  }

  case 'sessions': {
    // 窗口登记在 state.json 里（内存真源的落盘快照）
    const statePath = join(MIND_DIR(), 'state.json')
    if (!existsSync(statePath)) {
      out({ ok: true, windows: [], note: '还没有落盘快照（插件没运行过，或还没到落盘点）' })
      break
    }
    const st = JSON.parse(readFileSync(statePath, 'utf8'))
    out({
      ok: true,
      savedAt: st.savedAt,
      identity: st.identity,
      pursuits: (st.pursuits ?? []).filter((p) => !p.closedAt),
      windows: Object.entries(st.windows ?? {}).map(([id, w]) => ({
        id,
        short: shortId(id, 6),
        label: w.label,
        lastSeenAt: w.lastSeenAt,
        turns: w.turns,
      })),
    })
    break
  }

  case 'log': {
    const n = Number(argv[1] ?? 30)
    if (!existsSync(LOG_PATH())) {
      out({ ok: false, error: '日志还不存在: ' + LOG_PATH() })
      break
    }
    const lines = readFileSync(LOG_PATH(), 'utf8').trimEnd().split('\n')
    out(lines.slice(-n).join('\n'))
    break
  }

  case 'path': {
    out({
      dir: MIND_DIR(),
      log: LOG_PATH(),
      experiences: EXPERIENCE_DIR(),
    })
    break
  }

  // ⚠️ 已搬到 strand-cli 的命令：给一句明确指引，而不是让它们落进 default
  //   （default 只打 usage，退出码 0 —— 看起来"成功但没输出"，最难查的那种。）
  case 'remember':
  case 'note':
  case 'thread':
  case 'close':
  case 'show':
  case 'stale':
  case 'restore':
  case 'forget': {
    out({
      ok: false,
      error: `\`${cmd}\` 属于跨会话记忆，已搬到 dsh-strand`,
      hint: '请改用 strand-cli（在 dsh-strand 目录下：node lib/cli.mjs <命令>）',
    })
    process.exit(1)
    break
  }

  default:
    usage()
    if (cmd) process.exit(1)
}
