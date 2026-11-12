# dsh-mind

把 **跨会话脉络**、**经验库**、**自我觉知** 合成一个插件 —— 一套状态、一条注入、一条推送、一个预算。

整合自 `dsh-strand` + `dsh-tacit` + `dsh-psyche`。

**2026-11-08 拆分**：跨会话记忆（facts / timeline / threads）已整段移出到独立的 `dsh-strand` 插件。本包现在只做**自我觉知 + 经验库 + 压缩引擎**。
升级前请先读 [CHANGELOG.md](CHANGELOG.md) —— 有工具改名与数据目录变更。

---

## 它解决什么

上下文一压缩，AI 就不知道自己是谁了。

主流解法是「存更多、检索更准」，但**存得好**和**想得起来**是两件事。更根本的问题是：
压缩之后，模型拿到的是一份**别人写的摘要** —— 结构和价值观由摘要生成器决定，不是它自己。

dsh-mind 的做法不是把记忆堆得更高，而是让**记忆在压缩发生时就已经落到够不着的地方**：

| 通道 | 落点 | 压缩够得着吗 |
|---|---|---|
| 每轮注入 | 上下文 | ✅ 会被折掉 |
| 日记 | `~/.dsh/mind/diary/*.md` | ❌ |
| 状态（追求 / 窗口） | `~/.dsh/mind/state.json` | ❌ |
| 压缩前原文存档 | `~/.dsh/mind/archives/*.json` | ❌ |

> **2026-11-08 拆分说明**：事实 / 时间线 / 未结线索已搬去 `dsh-strand`，落在 `~/.dsh/strand/global.json`。
> 本包目录下残留的 `mind/global.json` 是迁移时的**旧副本**，插件已不再读写它；活数据在 `strand/` 下。
> 想让跨会话记忆生效，需要同时装 `dsh-strand`。

压缩因此从**单向门**变成**降采样**。

---

## 三段分别是什么

### 1. 跨会话脉络（第三人称）— 已拆分，见 dsh-strand

告诉模型「你不是这个窗口里的第一个自己」：

- **已确认事实** —— 一条一句话，带失效标记与年龄
- **最近动向** —— 别的窗口在做什么
- **未结线索** —— 还没结掉的事

⚠️ 这一段 2026-11-08 起**不在本包**：facts / timeline / threads 连同 `notes/` 外置都归 `dsh-strand`。
对应的工具也改名为 `strand_remember` / `strand_recall` / `strand_forget` / `strand_keys`。
本插件只是**软依赖、只读**地看一眼那里的事实与动向，用来写压缩前日记（`lib/peer.js`）——读不到就留空，绝不 import 对方模块。

### 2. 经验库（规范）

`~/.dsh/tacit/experiences/*.md`，主人手写的条件性准则。

**只有命中的才进上下文**，没命中一个字都不进。命中靠信号推导（`task.*` / `tool.error` / `file.json` …）+ 条件求值，最多 3 条。

设计三条：命中才注入 / 不认识的条件下匹配失败（照猜去动手更糟）/ 信任分级决定它敢做什么。

### 3. 自我觉知（第一人称）

`mind_intend` —— 模型能**主动声明**「我在追什么」。

没有它，这个插件只是监控面板；有了它，才是表达器官。

---

## 工具（7 个）

> 2026-11-08 拆分后，`mind_remember` / `mind_recall` / `mind_forget` / `mind_keys` 这四个跨会话记忆工具**已随 facts/timeline 一起搬去 `dsh-strand`**，改名为 `strand_*`。要在本包找它们会扑空——装 `dsh-strand` 才有。

| 工具 | 用途 |
|---|---|
| `mind_intend` | 声明 / 关闭「我在追什么」 |
| `mind_view` | 看全貌：注意力分散在哪几处 |
| `mind_status` | 排查「记忆好像没生效」：开关、**最近注入情况**、预算 |
| `mind_windows` | 列此刻醒着的窗口 |
| `mind_expand` | **取回被压缩折叠掉的原文**（按 seq） |
| `mind_search` | 在压缩存档里按关键词搜，拿到 seq 再 expand |
| `mind_compress` | 主动请求压缩（排队 → idle 执行 → 下一回合回报） |

---

## 安装

### 1. 接入插件

```bash
# 在 profile 的 node_modules 建 junction 指向本包
mklink /J "%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-mind" "<本包路径>"
```

然后在该 profile 的 `package.json` 里：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-mind"] } },
  "dependencies": { "dsh-mind": "link:<本包路径>" }
}
```

⚠️ **不要跑 `npm/pnpm install`** 去装插件 —— 会改写 profile 的依赖树。

### 2. 压缩引擎接线（必须手动，见下）

`cordis.patch.yml` 只插入主插件本身。压缩引擎的替换**必须在 profile 层**写：

```yaml
- id: compaction-basic
  name: dsh-mind/compaction    # 从 @deepseek-ai/dsh-compaction-basic 换成这个
```

**为什么不在本包的 patch 里写**：Cordis 的 patch 分组合包层（bundle）与用户层（profile）。
用户层优先级更高、应用在组合包层**之后**，所以在 bundle 层写的替换会被 profile 再覆盖回去 ——
白改且无声。这是分层限制，不是取舍。

### 3. 配置

`~/.dsh/mind.json`，全部键可选：

```json
{
  "diary": { "pressureRatio": 0.62, "contextWindow": 600000 },
  "inject": { "gapMs": 45000, "fullEvery": 6 },
  "tacit": { "enabled": true, "inject": true }
}
```

未知键会被**忽略**（不是照抄）—— 旧配置里的键升级后可能含义变了。

---

## 配置要点

### `diary.pressureRatio`（默认 0.62）

压力到这个比例就先写日记落盘，**再**请求压缩。顺序不能反 ——
反了会把「写日记」这个动作本身打断。

为什么是 0.62 不是 0.7：宿主 `compaction-basic` 默认 `thresholdRatio` 0.8，
但装了 `context-lock` 会把上限锁小（本机是 406464）。0.7 时 dsh-mind 永远慢一步，
**一次都没触发过**。0.62 才抢在它前面。

### `inject.gapMs`（默认 45000）

自适应间隔：内容越长间隔越久。满负荷约 5600 tokens/次，30 分钟一次 → 8 小时约 90k tokens。

---

## 环境变量

| 变量 | 作用 |
|---|---|
| `MIND_DIR` | 数据目录（默认 `~/.dsh/mind`）。测试隔离靠它 |
| `MIND_CONFIG` | 配置文件路径（默认 `~/.dsh/mind.json`） |
| `MIND_EXPERIENCE_DIR` | 经验库目录（默认 `~/.dsh/tacit/experiences`） |
| `MIND_REFRESH_MS` | 注入最小间隔覆盖（测试用 0） |

⚠️ 经验的**默认**位置刻意留在 `~/.dsh/tacit/experiences` —— 那是手写资产，
不该跟着插件的数据目录搬。但它会随 `MIND_DIR` 的父目录移动，保证测试隔离不漏。

---

## 测试

```bash
npm test          # 或 node tests/regress.mjs
```

**662 项全通，49 个分组**（2026-11-10 复测；此前文档写 825/616/639/643 都是旧数字，已按本机 `node tests/regress.mjs`
的实际输出校正 —— 数字写错比不写更坏，会让人以为跑过）。测试硬隔离：整个跑在临时目录，绝不碰 `~/.dsh/mind`。

另有 `tests/reverse.mjs`（反向验证：故意破坏关键逻辑，确认测试真会红；
2026-11-09 重建后 **26 个破坏点全部抓到**，旧版 30 个里 11 个指向已拆去
dsh-strand 的文件，判据归属已移交）与 `tests/preflight.mjs`（装载前自检，
同日校正了拆分后过期的 5 条判据）。

日记三层取数（投影 → 字符估算 → 失败留痕）的专项反向验证：
`node tests/reverse-diary-20261109.mjs`。它构造「measure 返回 0 且投影为空」的真机情形，
断言必须走估算而不是静默跳过 —— 因为静默跳过正是这个 bug 藏了三天的方式。

> ⚠️ 绿本身不证明判据有区分力。本项目多次出现「测试全绿但实际没用」，
> 所以关键修复都要跑反向验证。

---

## 已知限制

- **压缩引擎接线必须手动**，见上文（Cordis 分层限制）
- **`mind_compress` 工具内不压缩**，只排队：`compactNow()` 在 turn 内必返回 busy
- **注入不是实时**：对端投递走 `inject()`（不唤醒），对端下次开口才看见
- **日记的压力是三层取数**：`measure()` → `contextPressure` 投影 → 字符估算。
  前两层在 pre-step 时机基本拿不到值（宿主 `usage-projection.js:183` 要求
  「已有一次 usage 样本」才给 `projectedTokens`），所以**常年走的是第三层估算**。
  估算是 `字符数 / 1.8`，口径偏保守，**不是精确值**；日志里会写「估算」字样，
  日记正文的压力行也会标注「字符估算，非精确值」（2026-11-09 起）。
- **日记含「我在追什么」段**（2026-11-09 起）：`mind_intend` 的未结追求
  （存本插件 `state.json`）会写进日记最前部；pre-step 与压缩强写两条路径都传。
  已关闭的追求不出现。
- **`mind_search` / `mind_expand` 只覆盖压缩存档**，不覆盖当前会话的对话历史。
  要搜历史对话得用宿主的 `session_search`。
- **第③点已解决**（2026-11-09 复核）：工具注册的「already registered」刷屏
  在 11-05 就已经修好，修复后日志为 `mind_* 工具已注册 :: N 个（第 1 次尝试）`，
  无报错。不要再把它当现存问题反复改。
- 依赖 Node 内置模块，零运行时依赖

---

## 许可

MIT，见 `LICENSE`。
