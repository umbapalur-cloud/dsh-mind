# CHANGELOG

本文件只列**已核实**的变更。

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
