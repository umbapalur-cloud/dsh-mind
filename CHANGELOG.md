# CHANGELOG

本文件只列**已核实**的变更。

---

## v1.1.0 — 2026-11-22（性能、检索、经验库与双核软联动全面升级）

- **工具账本异步化与内存缓存**（`lib/tool-ledger.js`、`lib/io.js`、`lib/index.js`）：新增 `mtimeMs:size` 内存缓存、`deferMs: 1200` 异步防抖批写（`ctx.effect` 退出兜底 `flush()`）、紧凑 JSON 落盘（体积直降 ~40%）、`statSync().size` 轻量化统计与大输出标记；Windows 原子重命名支持 `EPERM/EBUSY/EACCES` 退避重试，读取自动剥离 UTF-8 BOM。
- **生命线去污与增量去重**（`lib/lifeline.js`、`lib/index.js`）：原话引语仅从正文抽取并过滤模板占位引语与 `AGENTS.md` 路径；双循环合并为单趟扫描；新增索引文件签名缓存；`pickRelevant()` 同时覆盖 `quotes`；`pre-step` 增量注入新增生命线去重与相关月份精准提示。
- **存档检索与还原升级**（`lib/archive.js`、`lib/infer-region.js`）：`listArchives()` 改为按 `(sessionKey, startSeq, endSeq)` 数值排序；`expandRegion()` 按文件名范围提前剪枝；`searchArchives()` 升级确定性相关性打分；`infer-region.js` 纳入工具调用/结果签名并修复空串误匹配。
- **日记、经验库与主动推送可靠性**（`lib/diary.js`、`lib/segments/tacit.js`、`lib/state.js`、`lib/index.js`）：日记改为懒加载 `getPeer` + 无时间线时的会话尾段回退 + 原子写入再轮转；经验库新增文件签名缓存、frontmatter `keywords` 解析、`task.after-change` 动作推导及标题字符预算计入；主动通知 `notice` 在精确节流后消费且豁免节流；追踪 `mind_intend` 原地更新指纹。
- **与 `dsh-neural-memory` 零耦合软联动**（`lib/compaction.js`、`lib/tools.js`）：若宿主同时加载 `neural-memory`，压缩总结与核心意图声明会异步静默同步至 `namespace: "mind"`，无硬依赖；`summarize()` 补齐配置文件回退；回归测试 **808/808** + 新增升级测试 **18/18** 全绿。

---

## v1.0.x — 2026-11-20（工具注册：修两个永久放弃/永久缺失的 bug）

回归 **808/808 通过**（第 59 组从 10 项重写为 28 项行为级判据，净增 15 项）。

### 起因

外部代码审查报告指出「工具注册遇到部分失败时提前停止重试」。
逐条核对源码后确认属实，且**比审查描述的更严重**——审查只看到 bug ①，没看到 bug ②。
存档清理那一条按既定设计决定保留不自动删，本节不涉及。

### bug ① · 部分成功即视为全部成功 → 失败的工具永久缺失

- **位置**：`lib/index.js` 旧 `tryRegisterTools()`，`if (n > 0) { registered = true }`。
- **后果**：7 个 `mind_*` 工具里 1 个抛普通错误、其余 6 个成功 → `n=6 > 0` → 认定全部完成 →
  定时器被清掉 → 后续 `tools/change` 也被 `registered` 挡住。
  那个失败的工具**永久缺失**，而日志写「已注册 6 个」。
- **修法**：判据改成 `done` 覆盖**全部定义名**（`missingNames().length === 0`）。
  部分成功时保持 `partial` 状态，`tools/change` 与轮询继续补缺失项，且只碰缺的那些。

### bug ② · 工具服务未就绪也消耗尝试次数 → 10 秒后永久放弃且零日志

- **位置**：同上，`attempts++` 在 `if (!tools?.register) return` **之前**。
- **后果**：500ms 轮询 × `MAX_ATTEMPTS=20` = **10 秒**。宿主 `tools` 服务 10 秒没就绪，
  插件就永久放弃，**7 个工具一个都没有**，而且这条路径是静默 `return`，**一行日志都不打**。
  后果比 bug ① 严重：不是「部分工具缺失」，是全部没有，日志干净得像正常启动。
- **修法**：区分两种计数——`attempts`（真注册失败）与 `notReady`（服务未就绪）。
  未就绪**不消耗**注册次数，独立上限 600 轮（≈5 分钟）。服务晚到仍能正常注册。

### 附带修好的三处

1. **「已注册」日志的数量是假的**：旧代码 `n` 是「成功 + 已存在」的合计，不是真实注册数。
   现在写 `${done.size}/${total}`。
2. **放弃时只写「注册失败」，不写缺谁**：现在明确列出未注册的名字清单。
3. **卸载残留**：`setInterval` 绑定到 `ctx.effect` 清理。
   ⚠️ 顺带**取证澄清**：`ctx.on` **不需要**手动清——读 `@deepseek-ai/cordis` 的
   `EventsService.register()`（asar 内 `lib/index.js:919-929`），它内部走
   `this.ctx.fiber.effect(...)`，fiber 卸载时自动 unregister。所以本文件那 9 处
   `ctx.on` 不加 `ctx.effect` 是**正确**的，此前评审里怀疑的「监听器泄漏」不存在。

### 结构性改动：逻辑抽成 `lib/tool-register.js`

**原测试是假绿的**（这是本次最值得记的一条）：

- 第 59 组前 7 条用 `readFileSync` + 正则匹配 `index.js` 的**源码文本** → 改个变量名就红，逻辑改错不红；
- 后 3 条行为级测试，测的是**在测试文件里重新手写的循环副本**（旧 `regress.mjs:1687-1708`），
  跟真实代码毫无绑定 → `index.js` 改坏了它照样绿。

根因：那段逻辑内联在 `apply()` 闭包里，外部拿不到。现在抽成 `lib/tool-register.js`，
导出 `createToolRegistrar()`，测试直接 import 真模块喂假 `ctx`/假 `tools`。

### 判据（第 59 组，28 项全部行为级）

覆盖：一次全成功 / bug① 部分失败不完成且精确指出缺谁 / bug① 恢复后只补缺失项 /
bug② 未就绪 50 轮 attempts 仍为 0 / bug② 服务晚到仍能注册 / 未就绪上限与放弃日志 /
「已存在」算成功且不刷日志 / 真失败达上限写清名单 / 定时器登记进 `ctx.effect` /
`tools/change` 不消耗 attempts / 定义生成抛错不假装完成。

### 反向验证（证明新测试真有区分力）

- 把 bug① 改回去（`missingNames().length === 0` → `done.size > 0`）→ **7 项转红**；
- 把 bug② 改回去（未就绪分支加 `attempts++`）→ **4 项转红**；
- 恢复后复跑 → **808/808 全通过**。

### 生效方式与回滚

- link 接入，**需重启 DSH 生效**。重启后查 `mind.log`：
  正常应见一行 `mind_* 工具已注册 :: 7/7 个（第 N 次尝试）`；
  若见 `工具注册放弃 :: ... 仍未注册 N 个 :: <名字>`，说明有工具真失败，日志会直接点名。
- 回滚：两份 `.bak-toolreg-20261120-012400` 覆盖回去即可（`lib/tool-register.js` 届时无人 import，无副作用）。

---

## 未发布 — 2026-11-16 晚（体检 A5/A6/A7：垃圾桶接线、旧纸条标龄、报表补列）

回归 **791/791 通过**（新增 17 项判据），输出 `dsh-optimize/mind-regress-20261116-a5a6a7.out`。备份 `lib/{index,tool-ledger,state}.js.bak-a5a6a7-20261116`。

### A5 · 死会话账本清理（启动按龄期，**不挂 disposed**）

- **血证**：`clearSession()` 写好后全库零调用，账本按会话累格只进不出（真机半天 2 格→6 格）。
- **第一版修法（已作废）**：disposed 即清 + 启动 7 天兜底。**19:41 重启验收时推翻**：本宿主同一 session 的 agent 每次重启都 disposed 再 created（真机日志 19:35:49 disposed 80e900… → 19:36:09 同 id created）——照那版，每次重启都会抹掉当前会话的账本，恰好毁掉「跨压缩/跨重启存活」这个立身之本。**幸好当时 psyche 关闭、验收用的又是新进程，历史实际未被清**（6 格全在，最后动静时间核对过）。
- **最终修法**：清理只走启动时 `sweepSessions(maxAgeMs=7天)`——判据是**格内最后一条动静**的龄期，活会话（含刚重启回来的）绝不动。`clearSession` 保留给显式清理场景（CLI/测试），注释写明不许挂 disposed。
- 与存档清理的边界：存档是原文唯一备份→只报告不删；账本只是流水索引（原文另有存档）→可按龄期真删。
- 顺手修：`index.js:83` / `state.js:25`「disposed 从未触发过」的过时注释（本轮日志实测多次触发）。
- **判据**：91-⑩ 组 6 项，其中「disposed 真接线」已反转为「**disposed 不许清账本**」（重启≠会话死亡）。

### A6 · 陈旧追求句标龄（只标注，不自动关）

- **血证**：3 条未结追求停在 9~12 天前且互相矛盾（同一件事的「已完成/进行中/刚开工」三个阶段快照），被原样注入每个窗口、写进日记。
- **修法**：`io.js` 新增 `pursuitStaleNote(at, now)`——≥3 天未更新返回「（N 天未更新，可能已完成或已放弃；确认后用 mind_intend {close} 关掉）」，否则空串。接到**三个出口**：psyche 注入段（renderPursuits）、压缩前日记（composeDiary）、mind_view（stale 字段）。
- ⚠️ 刻意不自动 close：陈旧≠完成，自动关会误杀长任务（反例已写进注释与测试）。
- 数据卫生：三条陈旧追求已用 mind_intend {close} 显式关闭（cctriua1/bsgocjl2/8m5urfdi），当前未结 1 条（本轮体检修复主线）。
- **判据**：93-①②③④ 组 10 项（门槛两侧/坏输入/注入带警示/新鲜不误报/不自动关/日记带警示/mind_view 字段）。

### A7 · injected 日志补 led= 字段

- **血证**：段明细 `[life= psy= dia= tac=]` 漏了 ledger——账本注入量在日志里不可见（14:43 那次实际注入 1000+ 字符账本，日志无痕）。
- **修法**：格式串补 `led=${segments.ledger.length}`，五段齐全。
- **判据**：93-⑤（源码级钉住字段顺序）。

### 生效方式与回滚

- link 接入，**需重启 DSH 生效**。19:41 重启验收：✅ injected 日志出现 `led=804`（A7 生效独有证据）；✅ mind_view pursuits 带 `stale` 字段（A6 生效独有证据）；✅ 账本新条目带一句话摘要（注入可见「跑回归测试验证…」等）。A5 最终版（仅启动 sweep）待下次重启看「启动清理账本」日志——当前 6 格全部 7 天内有动静，**不清才是正确行为**，真删要等首个格满 7 天（最早 11-23）。
- 回滚：三份 `.bak-a5a6a7-20261116` 覆盖即可（io.js/psyche.js/diary.js/tools.js 的改动为纯增量函数与一行接线，回滚 index/tool-ledger/state 三份后其余新增函数无人调用、无副作用）。

---

## 未发布 — 2026-11-16（体检 A1/A2：两处「写了却没接线」）

取证：`dsh-optimize/recon-2026-11-16-mind-audit.md`。回归 **774/774 通过**（新增 14 项判据），输出 `dsh-optimize/mind-regress-20261116-a1a2.out`。

### A1 · lifeline 的 rebuildEveryMs 从死配置变成真消费

- **血证**：`config.js` 定义 `rebuildEveryMs: 6h`、`index.js` 注释承诺定时重建，但实现只有「渲染为空才 rebuild」——该键全库零消费，`builtAt` 只写不读。索引建一次后**永不更新**，新日记静默进不了月索引。
- **修法**：`lifeline.js` 新增 `rebuildDue(everyMs, now)`（读 builtAt 判龄期；无/坏 builtAt 或非法间隔一律保守判到期）；`index.js` 注入路径改为先问 `rebuildDue` 再决定 rebuild，重建留日志（含原因）。
- 顺手修：注入文案 `mind_lifeline {expand:"YYYY-MM"}` → `{ym:"YYYY-MM"}`（真实参数是 ym，expand 会被忽略落到列目录分支）。
- **判据**：第 90-⑫ 组 5 项（fresh 不到期 / aged 到期 / 非法间隔保守 / index.js 真消费 / 文案参数名一致）。
- 真机只读验证：`rebuildDue(6h)` 对真实索引返回 `{due:false, reason:'fresh', ageMs:5763333}`；渲染尾部已是 `{ym:"YYYY-MM"}`。

### A2 · 工具账本的「一句话摘要」从恒空变成真生成

- **血证**：设计承诺「工具名+成败+大小+一句话」，但 pre 不传 summary、settle 不补——真机 35 条 summary 全空。压缩后账本答不出「查的是什么」。
- **修法**：`tool-ledger.js` 新增 `summarizeArgs(tool, args, maxChars)`——确定性字段表提取（description > file_path/path 尾段+动词 > pattern/query > url > name > prompt 首行），提取不到返回空串不编；`index.js` pre-execute 记账时传入。settle 用 spread 保留原条目，摘要天然不被冲掉（有判据钉住）。
- 顺手修：render 省略脚注不再指「用 mind_search 搜关键词」——账本不在压缩存档里，那是走不通的路。
- **判据**：第 91-⑨ 组 9 项（提取优先级/截断/坏入参不抛/settle 后摘要仍在/渲染带出/脚注不指错路）。
- 真机只读验证：`summarizeArgs('pwsh', {description:'查看 mind.log 大小与最近日志'})` → 原样返回。

### 生效方式与回滚

- profile 以 `link:<本包路径>` 接入，**改源码即改安装位**；插件代码常驻内存，**需重启 DSH 才生效**（重启后看 mind.log 出现「生命索引已重建 :: …原因 aged」与账本新条目带 summary 即为生效证据）。
- 回滚：`lib/{lifeline,index,tool-ledger}.js.bak-a1a2-20261116` 三份备份原样覆盖即可。
- ⚠️ 重启前的过渡期：注入文案仍是旧的 expand 写法（内存里是旧代码），下一回合看到 `{ym:…}` 才是新代码生效。

---

## v1.0.3 — 2026-11-12（日志说实话：34 次「失败」里没有一次是故障）

### 一句话

v1.0.2 之后真机复现发现：那 34 次「四层取数全失败」**全部**发生在「新会话第一句话」，那时**根本没有历史可测**（压力 3.7%~5.2%，阈值 62%）。它不是故障，是正常噪音。本版把日志拆成两种文案，**判断逻辑一行没动**。

### 🩸 血证：34/34 全部是「新会话开头」，不是压缩前

```
紧跟在「窗口首次说话」之后:  34 / 34   （无一例外）
其它场景:                    0 / 34
```

而那些会话的压力实测：

```
29fcda : 3.8%     b28311 : 3.7%     5f3261 : 3.8%
3bff48 : 3.7%     59a94d : 5.2%     threshold = 62%
```

**差 12~17 倍，这些会话永远到不了需要日记的时候。**

反向对照 —— 真正长到阈值的会话，日记**一次没漏**：

```
[11-06 07:11] 62%（压力达阈值）  [11-06 17:25] 64%
[11-07 13:47] 64%                [11-08 11:29] 63%
[11-10 04:50] 63%                [11-10 10:49] 62%
[11-11 12:00] 62%
```

### 为什么新窗口必然测不出来

一个新会话开头的事件序列（真实日志）：

```
seq 0  permission/preset
seq 1  sandbox/mode
seq 2  approval/policy
seq 3  subagent/model-selection-policy
seq 4  model/selection
seq 5  agent/inbox/spliced
seq 6  turn/start          ← pre-step 在这里，日志只到这儿
```

**一条消息都还没有**，更没有 `assistant/message` → measure 回放为空、usage 层无数据。这是物理上测不出来，不是代码写错。

### 改动（**只改文案分流，不改判断逻辑**）

| 场景 | 旧文案（每次开新窗口都打） | 新文案 |
|---|---|---|
| 新会话开头、无历史 | `日记跳过 :: 四层取数全失败（…no-usage-in-tail，seq=6）` ← **像报错** | `日记跳过 :: 新会话开头、还没有历史可测（正常，非故障）（seq=6，assistant/message=0，压力远低于 62% 阈值，此时不需要日记）` |
| 有历史却仍测不出 | 同上，无法区分 | `日记跳过 :: 四层取数全失败（…assistant/message=N）` ← **这句才代表真故障** |

**新增判据 `probeFreshSession()`（确定性，数事件不靠猜）**：

```
isFresh = (session.seq <= 40) && (assistant/message 计数 === 0)
```

⚠️ **两个条件必须同时成立**。只判 `assistant/message === 0` 会把「日志损坏、eventAt 全返回 undefined」的长会话误判成新会话，**真故障就被藏起来了**（已在反向验证 ① 中实测）。

⚠️ **两个分支共用同一个 `return fail('zero-tokens')`** —— 行为完全一致（都不写日记），变的只是日志有没有说实话。已加断言守住这点。

### 顺手修掉一个会崩的坑

新分支里要打阈值百分比，但 `threshold` 定义在**后面 26 行**（:857），在此处引用是 **TDZ，会直接抛 ReferenceError**。改成就地按同口径算：

```js
const thr = Number.isFinite(cfg.pressureRatio) ? cfg.pressureRatio : 0.62
```

已加断言 `★★ 新会话分支里不引用后定义的 threshold（防 TDZ ReferenceError）` 守住。

### 验证

```
总计 690 项：通过 690，失败 0
```

**真机双场景实测**（调真实的 `maybeWriteDiary`，非复制代码）：

```
A. seq=6、无 assistant/message
   → 日记跳过 :: 新会话开头、还没有历史可测（正常，非故障）（session.seq=6，
     assistant/message=0，user/message=0；压力远低于 62% 阈值，此时不需要日记）
   → wrote:false  ✅ 正确（本来就该跳过，但不再谎报故障）

B. seq=3368、eventAt 全失败（模拟日志损坏）
   → 日记跳过 :: 四层取数全失败（…session.seq=3368，assistant/message=0）
   → wrote:false  ✅ 真故障仍然喊得出来
```

**反向验证 3 个破坏点，全部抓到**：

| # | 破坏 | 测试反应 |
|---|---|---|
| ① | 判据只判 `assistantCount === 0` | ❌ `★★ 新会话判据要求「seq 短」且「一条 assistant/message 都没有」` |
| ② | 两种文案合并回一种 | ❌ `★★★ 两种不同文案` + `★ 共用同一个 return fail` |
| ③ | 引用后定义的 `threshold` | ❌ `★★ 防 TDZ ReferenceError` |

### 回滚

```
copy lib\diary.js.bak-freshlog-20261112-155634 lib\diary.js
copy tests\regress.mjs.bak-freshlog-20261112-155634 tests\regress.mjs
（version 改回 1.0.2）
```

---

## v1.0.2 — 2026-11-12（修「三层取数」的伪兜底：34 次日记写不出来）


### 一句话

原「三层取数」里有**两层依赖同一个会空的源**，第三层是**伪兜底**。真机 4 天里 **34 次**「该写日记但没写」，全栽在这里。新增第 ④ 层，改用宿主记录的**提供方真实用量**。

### 🩸 血证：所谓「三层」其实只有两层独立

**现象**（`mind.log` 实测统计）：

```
「三层取数全失败」  34 次
  2026-11-09  12 次 / 11-10  11 次 / 11-11  8 次 / 11-12  3 次
「计量结果不可用 totalTokens=0」  46 次
失败原因固定同一句：
  measure.totalTokens=0，contextPressure=projected=undef,pressure=undef，估算=no-surface-nodes
```

**根因**：`lib/diary.js` 的取数链设计成三层，但第 ① 层和第 ③ 层**读的是同一个东西**：

| 层 | 取数源 | pre-step 时 |
|---|---|---|
| ① `meter.measure()` | 回放 `session.surface.nodes` | **空** → totalTokens=0 |
| ② `contextPressure` 投影 | 需已有 usage 样本 | pre-step 是首次请求前，**必然 undefined** |
| ③ `estimateTokensFromSession()` | 也读 `session.surface.nodes` | **空** → `no-surface-nodes` |

**第 ③ 层本意是"兜底"，却和失败的第 ① 层死在同一个假设上。** 于是三层一起哑火，日记整天不写。

### ⚠️ 中途走错过一条路（已作废，写在这里防止再走）

女仆第一版修法是「**扫会话日志尾部，按字符数估算**」，读 `session.seq` + `eventAt(seq)`。看起来绕开了 surface，代码也跑通了。

**实测发现它测不准**：

```
本会话 3370 条事件 / 962 条 surface 节点 / 总计 1,825,785 字符
  尾部 400 条日志 → 只含 102 条 surface 事件，覆盖 122,494 字符 = 6.7%
  要覆盖 90% 字符 → 需从 idx 142 扫起 = 几乎全扫 3228 条
```

字符分布太均匀（单条 `tool/result` 动辄 3 万字符，散落在全程），**扫尾部无论取多大都测不准**；而 `maybeWriteDiary` 是**每轮 pre-step 都调**的，全扫会变瓶颈。

→ **扫描这条路根本不成立。** 第一版已删除，代码里留了注释说明为什么不能用。

### ✅ 正解：用宿主记录的提供方真实用量

`assistant/message` 事件的 `data.usage` 携带该次请求的**精确用量**。按宿主自己的公式（`dsh-token-meter/lib/types/usage-projection.js:58`）：

```
pressureTokens = inputTokens + cacheReadTokens + cacheWriteTokens
```

**真机实测**（seq=3366）：`{inputTokens:886, cacheReadTokens:53376}` → **54,262 tokens**，与宿主口径完全一致。

**端到端验证**（模拟 `surface.nodes = []` 的空场景）：

```
session.seq = 3368, surface.nodes.length = 0   ← 模拟 pre-step
tokenFromLastUsage() → tokens = 54262, reason = no-surface-nodes|usage@seq3366
压力 = 54262 / 600000 = 9.04%   ✅ 取数成功（不再是"失败"）
```

### ⚠️ 已知偏差（诚实记录，不粉饰）

`usage` 算的是「**上一次请求**的 prompt 规模」，`measure()` 算的是「**当前 surface** 全量」，所以**本层总是偏小**：

```
实测对照： measure=74829  vs  usage=54262   差 20567（27.5%）
方向确认：只低估，不高估（少算的正是上次请求之后新产生的输出）
```

**为什么可接受**：阈值 62%，偏小约 27% → 实际拖到约 85% 才写，而压缩通常在 90%+ 才触发，**来得及**。
**未来若出现「日记总是晚一拍」**，第一嫌疑就是这一层偏低。

### 改动清单

| 文件 | 改动 |
|---|---|
| `lib/diary.js` | 新增 `tokenFromLastUsage()`；`estimateTokensFromSession()` 在 surface 为空时**转交**而非直接 return；日志区分「用量实测 / 字符估算」；失败文案改「四层取数全失败」并带 `session.seq` |
| `tests/regress.mjs` | 新增 6 项断言；旧断言「三层取数全失败」放宽为 `[三四五]层`（钉死文案正是它自己注释里警告过的反模式） |

### 验证

```
总计 683 项：通过 683，失败 0
✅ 自检通过（0 个提醒）—— 可以重启

反向验证 4 个破坏点，全部被抓到：
  ① surface 为空时改回直接 return  → ❌ ★★ surface 为空时不再直接 return
  ② 压力公式漏掉 cacheRead          → ❌ ★★★ 压力公式与宿主同口径
  ③ 把实测值谎报成「估算」          → ❌ ★ 实测值不许写成「估算」
  ④ 读 user/message 而非 assistant  → ❌ ★★★ 读的是 assistant/message 的 data.usage
```

### 回滚

```
copy lib\diary.js.bak-usage-20261112-153759 lib\diary.js
copy tests\regress.mjs.bak-usage-20261112-153759 tests\regress.mjs
（version 改回 1.0.1）
```

---

## v1.0.1 — 2026-11-12（压缩摘要改第一人称 + 修死开关）

### 一句话

压缩后的「记忆」不再由第三方压缩器代写：**指令改成「你就是这个助手本人，给自己写交接便条」**。同时修掉一个从上线起就没通上电的配置开关。

### 🩸 血证：`summarizationProvider` 是死开关

**现象**：`lib/compaction.js:315` 一直在读 `config.summarizationProvider` / `config.summarizationModel`，看起来是个「给压缩单配模型」的开关。

**根因**：`DEFAULT_CONFIG` 里**没有这两个键**，而 `mergeKnown()` 只遍历 `Object.keys(defaults)`（`lib/config.js:124`）。所以主人真写进 `~/.dsh/mind.json` 的值会被**静默丢弃**，条件恒为 `undefined`。

**为什么长期没被发现**：回退链 `configured ?? latest ?? agentTarget` 总能兜住，不报错、日志里也看不出来。只有真想「给压缩单配模型」时才会撞上。

**修法**：`DEFAULT_CONFIG` 补上这两个键（缺省 `''` = 走回退链，行为不变）。

**验证**（本轮实测）：
- 新增 6 项断言（存在性 + 有效性两层，只有存在性不够——键存在但合并时被丢掉正是本次事故）。
- 反向验证：通过代码编辑删掉这两个键 → **6 项全红**；恢复 → **668/668 全绿**。

### 🔧 压缩摘要改第一人称（主人 2026-11-12 选 B 档）

**改前的指令开头**：「你现在是这个 AI 助手的**上下文压缩器**……让另一个模型继续工作」——把女仆的身份**外包给了第三方视角**。

**改后**：「你就是上面这段对话里的那个助手本人……把这段对话压缩成一份**写给自己的交接便条**」。

**为什么不只是改人称**：第三人称视角会天然写成「它做了什么」的流水账，第一人称才会写「我为什么这么做」。

**配套三条硬规则**：
1. **全篇第一人称**，出现「助手/该模型/它」即违规。
2. **证据分级**：`已验证`（须指出工具输出或文件行号）/ `⚠️ 记不清，需重查` / `⚠️ 女仆的推断，未验证`——三者不许混写。
3. **旧便条是我自己以前写的**，若新证据与它冲突，以新证据为准并写明「旧结论作废」。

**⚠️ 为什么不是「换个专用摘要模型」**：换模型只改「谁来执行摘要」，不改「以什么身份写」。第三方小模型写第一人称反而更容易写出「我」开头的流水账而没有真正的自我连续性。真正的修法是指令本身。

### 🔧 日记措辞修正

`lib/diary.js` 原来写「下面是女仆**亲手写的**；摘要是**别人写的**」——两处都不准确：

- ① 日记不是压缩前一刻现写的，是**代码按模板拼装**的（该文件 `llm` / `stream(` grep 命中 **0 次**）。数据确实是女仆平时用 `mind_intend` 等工具登记的，但拼装是机械的。
- ② B 档之后摘要也归女仆写，不再是「别人写的」——原句会与实际相矛盾。

改成说明「怎么来的」+「所以该信到哪一步」，把可信度讲清楚而不是打包票。

### 🧪 测试

- **668 项 / 49 组**（2026-11-12 复测，原 662 + 新增 6）。
- `tests/preflight.mjs`：自检通过，0 个提醒。
- 反向验证：新增 6 项有区分力（删掉修复即全红）。

### 📌 生效方式

**需重启 DSH**——`lib/` 是 ESM 模块，已加载的指令常量不会热更新。

---

## v1.0.0 — 2026-11-08 拆分后（当前版本）

### 一句话

从「三合一」拆成专做**自我觉知 + 经验库 + 压缩引擎**。跨会话记忆整段搬去 `dsh-strand`。

### ⚠️ 破坏性变更（升级前必读）

| 变更 | 从 | 到 | 影响 |
|---|---|---|---|
| **跨会话记忆移出** | 本包含 facts / timeline / threads | 全部搬去 `dsh-strand` | `~/.dsh/mind/global.json` 已迁移到 `~/.dsh/strand/global.json`。**本包目录下的 `mind/global.json` 是迁移遗留副本，插件已不再读写它** |
| **4 个记忆工具改名并移出** | `mind_remember` / `mind_recall` / `mind_forget` / `mind_keys` | `strand_remember` / `strand_recall` / `strand_forget` / `strand_keys` | 装 `dsh-strand` 才有；在本包找会扑空 |
| **工具数量** | 11 个 | **7 个** | 见下 |
| **数据目录分离** | 全部在 `~/.dsh/mind` | 记忆在 `~/.dsh/strand`，本包只管 `~/.dsh/mind`（diary / archives / state） | 备份、清理脚本要分别处理两个目录 |
| **跨会话不再是本插件职责** | — | 变成**软依赖**：写压缩前日记时尽力读一份 `dsh-strand` 的 facts/timeline 摘录 | 没装 `dsh-strand` 时日记里那段留空，**不报错、不阻塞** |

### 🔀 移出（去了 dsh-strand）

以下 5 个模块连同职责整体搬走：

- `global.js`（facts / timeline / threads 存储）
- `segments/strand.js`（跨会话脉络注入段）
- `notes.js`（长事实外置）
- `layers.js`（事实分级）
- `aging.js`（事实年龄标记）

### ✨ 新增

- **`lib/peer.js`（软依赖桥）**：写压缩前日记时，尽力读一份 `dsh-strand` 的 facts/timeline 摘录。
  - **绝不 `import` 对方的模块**。理由写在文件头：卸载即崩 / 版本锁死 / 循环依赖。读不到就留空。
- **`diary` 增加「我在追什么」段**（2026-11-09）：`mind_intend` 的未结追求会写进日记最前部，pre-step 与压缩强写两条路径都传。已关闭的追求不出现。
- **日记压力行标注**（2026-11-09）：压力值是字符估算时会明确标「字符估算，非精确值」，不伪装成精确值。
- **`tests/reverse-diary-20261109.mjs`**：日记三层取数的专项反向验证。构造「measure 返回 0 且投影为空」的真机情形，断言必须走估算而不是静默跳过。

### 🔧 保留并修复

- **压缩引擎**（`compaction.js`）：中文摘要 + 压缩前日记 + 可逆存档 + 主动压缩。压力阈值 `pressureRatio` 默认 **0.62**（不是 0.7）——因为宿主 `compaction-basic` 的 `thresholdRatio` 是 0.8，而 `context-lock` 会把上限锁小（本机 406464），0.7 时永远慢一步、一次都没触发过。
- **`mind_search` / `mind_expand`**：在压缩存档里按关键词搜、按 seq 取回被折叠的原文。
- **工具注册刷屏已修**（2026-11-05）：`already registered` 被当成失败会无限重试刷屏。现在「已存在」记为成功，日志为 `mind_* 工具已注册 :: N 个（第 1 次尝试）`，无报错。

### ⚠️ 遗留代码（不影响运行，但要知道）

- `lib/io.js` 仍导出 `GLOBAL_PATH()`，`lib/tools.js:31` 仍导入它，但**实际未使用**——真正的对端路径走 `peer.js` 的 `PEER_GLOBAL_PATH()`。这是拆分时留下的死导入，不读也不写本包的 `global.json`。留着是历史包袱，清掉更干净。

### 📝 文档

- README 重写。修正四处过期：工具数 11 → 7、测试数 643 → **662**、数据落点（facts 已不在 `mind/global.json`）、「跨会话脉络」段落改指路 `dsh-strand`。
- 新增本 `CHANGELOG.md`。

### 🧪 测试

- **662 项 / 49 组**（2026-11-10 复测）。
- `tests/reverse.mjs`：**26 个破坏点，抓到 26，漏掉 0**。
- `tests/preflight.mjs`：装载前自检。
- 全套硬隔离在临时目录，绝不碰 `~/.dsh/mind`。

### 📌 已知限制（沿用）

- **压缩引擎接线必须手动**：`cordis.patch.yml` 只插入主插件，压缩引擎替换必须在 profile 层写（Cordis 分层限制，bundle 层会被 profile 覆盖回去）。
- **`mind_compress` 工具内不压缩**，只排队，`compactNow()` 在 turn 内必返回 busy。
- **注入不是实时**：对端投递走 `inject()`，不唤醒，对端下次开口才看见。
- **日记压力常年走字符估算**：前两层取数在 pre-step 时机基本拿不到值。

---

## v1.0.0 拆分前（2026-11-07 及更早）

「三合一」形态：跨会话脉络（第三人称）+ 经验库（规范）+ 自我觉知（第一人称），一套状态、一条注入、一条推送、一个预算。

- 工具 11 个：`mind_intend` / `mind_view` / `mind_status` / `mind_remember` / `mind_forget` / `mind_recall` / `mind_keys` / `mind_windows` / `mind_expand` / `mind_search` / `mind_compress`
- lib 下 20 个文件（含 `global.js` / `notes.js` / `layers.js` / `aging.js` / `segments/strand.js`）；现为 16 个
- 历史备份包：`dist/dsh-mind-v1.0.0-20261107-014500.zip`

**该形态的缺陷**：跨会话记忆与自我觉知的生命周期、开关时机、故障影响面完全不同却绑在一起——跨会话数据坏了会连累压缩日记，跨会话关掉了自我觉知也停了。这是拆分的直接原因。
