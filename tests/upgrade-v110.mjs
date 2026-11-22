/**
 * tests/upgrade-v110.mjs —— dsh-mind v1.1.0 升级与修复专项验收
 * 全程隔离临时 MIND_DIR / MIND_CONFIG，绝不污染真实数据目录。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mind-v110-'))
process.env.MIND_DIR = path.join(tmpRoot, 'mind')
process.env.MIND_CONFIG = path.join(tmpRoot, 'mind.json')
process.env.MIND_EXPERIENCE_DIR = path.join(tmpRoot, 'experiences')
process.env.MIND_GAP_MS = '1'
fs.mkdirSync(process.env.MIND_DIR, { recursive: true })
fs.mkdirSync(process.env.MIND_EXPERIENCE_DIR, { recursive: true })

let passed = 0
let failed = 0
function assert(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  [PASS] ${name}${detail ? ' :: ' + detail : ''}`)
  } else {
    failed++
    console.error(`  [FAIL] ${name}${detail ? ' :: ' + detail : ''}`)
  }
}

async function main() {
  try {
    const Lifeline = await import('../lib/lifeline.js')
    const Archive = await import('../lib/archive.js')
    const Infer = await import('../lib/infer-region.js')
    const ToolLedger = await import('../lib/tool-ledger.js')
    const Tacit = await import('../lib/segments/tacit.js')
    const { Store } = await import('../lib/state.js')
    const { makeToolDefinitions } = await import('../lib/tools.js')

    console.log('=== 1. lifeline 剥离模板引号与路径 + pickRelevant 搜 quotes ===')
    {
      const sampleDiary = [
        '# 压缩前日记 · 2026-11-22 10:00:00 UTC',
        '## 给压缩后的自己',
        '- 严禁「上次是这样」「主人心情不好」「未结线索」',
        '- 参考 C:\\Users\\alice\\.dsh\\AGENTS.md',
        '## 我在追什么（mind_intend 的未结声明）',
        '- [p1] 主线：升级 dsh-mind 与神经记忆协同层',
        '## 压缩前最后几句对话（本窗口）',
        '- 10:00 [主人] 「不要静默吞掉配置错误」并检查 D:\\workspace\\dsh-mind\\lib\\index.js',
      ].join('\n')
      const sig = Lifeline.signalsOf(sampleDiary)
      assert('模板引号被彻底过滤', !sig.quotes.some((q) => q.includes('上次是这样') || q.includes('主人心情不好')),
        JSON.stringify(sig.quotes))
      assert('真实用户原话引号保留', sig.quotes.some((q) => q.includes('不要静默吞掉配置错误')), JSON.stringify(sig.quotes))
      assert('模板 AGENTS.md 路径被过滤，真实项目路径保留',
        !sig.paths.some((p) => p.endsWith('AGENTS.md')) && sig.paths.some((p) => p.includes('dsh-mind')),
        JSON.stringify(sig.paths))

      const diaryDir = path.join(process.env.MIND_DIR, 'diary')
      fs.mkdirSync(diaryDir, { recursive: true })
      fs.writeFileSync(path.join(diaryDir, 'sess1-2026-11-22T10-00-00.md'), sampleDiary, 'utf8')
      const rb = Lifeline.rebuild()
      assert('lifeline rebuild 成功', rb.ok && rb.months === 1)
      const rel = Lifeline.pickRelevant('记得不要静默吞掉配置错误这条规矩', 2)
      assert('pickRelevant 命中真实 quotes', rel.length === 1 && rel[0].ym === '2026-11', JSON.stringify(rel))
    }

    console.log('\n=== 2. archive 数值排序 + 相关度打分 ===')
    {
      const adir = Archive.ARCHIVE_DIR()
      fs.mkdirSync(adir, { recursive: true })
      const mk = (lo, hi, items) => {
        fs.writeFileSync(
          path.join(adir, `sessA__${lo}-${hi}.json`),
          JSON.stringify({ version: 1, sessionId: 'sessA', startSeq: lo, endSeq: hi, items }),
          'utf8',
        )
      }
      mk(10, 883, [{ seq: 10, type: 'user/message', text: '提到一次 neural 概念' }])
      mk(884, 2410, [{ seq: 900, type: 'user/message', text: '反复讨论 neural memory 升级 neural memory 架构 neural' }])
      mk(2413, 3260, [{ seq: 2500, type: 'assistant/message', text: '无关记录' }])

      const list = Archive.listArchives('sessA')
      const starts = list.map((f) => f.startSeq)
      assert('listArchives 按数值升序（10 → 884 → 2413，不再把 2413 排在 884 前）',
        starts[0] === 10 && starts[1] === 884 && starts[2] === 2413, JSON.stringify(starts))

      const sr = Archive.searchArchives({ sessionId: 'sessA', query: 'neural' })
      assert('searchArchives 高相关/高频条目排在前面而非死按最老优先',
        sr.ok && sr.hits[0]?.seq === 900 && sr.hits[0].score > sr.hits[1].score,
        JSON.stringify(sr.hits.map((h) => ({ seq: h.seq, score: h.score }))))
    }

    console.log('\n=== 3. infer-region 防空串错配 + tool-call 签名 ===')
    {
      const events = {
        1: { role: 'assistant', content: [{ type: 'text', text: '普通回复 A' }] },
        2: { role: 'assistant', content: [{ type: 'tool-call', toolName: 'pwsh', callId: 'c1' }] },
        3: { role: 'user', content: [{ type: 'text', text: '继续' }] },
      }
      const fakeSession = {
        surface: { nodes: [1, 2, 3] },
        eventAt: (s) => events[s],
        deriveEventMessage: (e) => e,
      }
      // 只找 seq 2..3（含纯 tool-call 消息）绝不能被 seq 1 误配
      const res = Infer.inferShadowedSeqs(fakeSession, {
        messages: [
          { role: 'assistant', content: [{ type: 'tool-call', toolName: 'pwsh', callId: 'c1' }] },
          { role: 'user', content: [{ type: 'text', text: '继续' }] },
        ],
      })
      assert('tool-call 签名精确定位 seq 2..3（不误配到 seq 1）',
        res !== null && res.seqs[0] === 2 && res.seqs[1] === 3, JSON.stringify(res))

      // 纯空串不匹配非空文本
      const fakeSession2 = {
        surface: { nodes: [1] },
        eventAt: () => ({ role: 'assistant', content: [{ type: 'text', text: '有内容' }] }),
        deriveEventMessage: (e) => e,
      }
      const resEmpty = Infer.inferShadowedSeqs(fakeSession2, {
        messages: [{ role: 'assistant', content: '' }],
      })
      assert('空文本绝不误匹配非空消息', resEmpty === null)
    }

    console.log('\n=== 4. tool-ledger 防抖合批落盘 + flush + bigResultChars 标注 ===')
    {
      const r1 = ToolLedger.record({
        sessionId: 'sid-l1',
        tool: 'pwsh',
        result: null,
        pending: true,
        callId: 'call-99',
        summary: '检查大日志',
        deferMs: 5000,
      })
      const r2 = ToolLedger.settle({
        sessionId: 'sid-l1',
        tool: 'pwsh',
        result: { isError: false, content: [{ type: 'text', text: 'x'.repeat(12000) }] },
        callId: 'call-99',
        deferMs: 5000,
      })
      assert('deferMs 模式内存立刻可查到最新结算状态', r1.ok && r2.ok && ToolLedger.list('sid-l1')[0]?.outcome === 'ok')
      const rendered = ToolLedger.render('sid-l1', 900, { bigResultChars: 8000 })
      assert('render 标注超过 bigResultChars 的大输出', rendered.includes('[大输出]'), rendered)
      const fl = ToolLedger.flush()
      const rawDisk = fs.readFileSync(ToolLedger.LEDGER_PATH(), 'utf8')
      assert('flush 写出紧凑 JSON（无多行缩进膨胀）', fl.ok && !rawDisk.includes('\n  "sessions"'), `bytes=${rawDisk.length}`)
    }

    console.log('\n=== 5. tacit 复活 L1 经验 + render 预算保护 ===')
    {
      const sigs = Tacit.deriveSignals('我在做反向验证，拆掉承重代码看看判红工具灵不灵')
      const hitAfter = sigs.find((s) => s.path === 'task.after-change')
      assert('task.after-change 识别 doing=反向验证', hitAfter?.context?.doing === '反向验证', JSON.stringify(hitAfter))
      assert('conditionHolds 命中 reverse-verify-harness-direction 条件',
        Tacit.conditionHolds('doing in ["反向验证", "写测试判据"]', hitAfter?.context))

      const tiny = Tacit.render([{ id: 'x', trust: 'L1', title: '长标题', action: '很长的动作说明'.repeat(20) }], 80)
      assert('tacit render 预算装不下任何一条时返回空串（不输出空壳标题）', tiny === '', `len=${tiny.length}`)
    }

    console.log('\n=== 6. Store 指纹覆盖追求更新 + tools 热加载穿透与软协同 ===')
    {
      const store = new Store()
      store.addPursuit('主线：升级插件阶段一', 's1')
      const fp1 = store.fingerprint()
      await new Promise((r) => setTimeout(r, 10))
      store.addPursuit('主线：升级插件阶段二（原地更新）', 's1')
      const fp2 = store.fingerprint()
      assert('Store.fingerprint 在原地更新追求进展时发生变化', fp1 !== fp2, `${fp1} vs ${fp2}`)

      let liveCfg = {
        tacit: { enabled: true, inject: true },
        psyche: { enabled: false, inject: false, collectTools: false },
        lifeline: { enabled: true, inject: true },
        toolLedger: { enabled: true },
        budget: { total: 6700 },
      }
      const nmObserved = []
      const fakeNm = { observe: async (t, o) => { nmObserved.push({ t, o }) } }
      const defs = makeToolDefinitions(store, {
        config: liveCfg,
        getConfig: () => liveCfg,
        getNeuralMemory: () => fakeNm,
        CLI_PATH: 'cli.mjs',
      })
      const statusTool = defs.find((d) => d.name === 'mind_status')
      const intendTool = defs.find((d) => d.name === 'mind_intend')

      liveCfg = { ...liveCfg, psyche: { enabled: true, inject: true, collectTools: true } }
      const stRes = await statusTool.execute({})
      assert('mind_status 实时穿透热加载配置且感知 neural-memory 协同',
        stRes.segments.psyche.enabled === true && stRes.segments.neuralMemoryPeer?.connected === true)

      await intendTool.execute({ text: '主线：验证双插件协同写入神经记忆' }, { agent: { id: 's1' } })
      await new Promise((r) => setTimeout(r, 30))
      assert('mind_intend 软协同旁路写入 neural-memory',
        nmObserved.length === 1 && nmObserved[0].o?.namespace === 'mind')
    }

    console.log(`\n========================================`)
    console.log(`dsh-mind v1.1.0 升级专项验收：PASS=${passed}, FAIL=${failed}`)
    console.log(`========================================`)
    if (failed > 0) process.exitCode = 1
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

main()
