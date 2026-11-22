/**
 * lib/tool-register.js —— `mind_*` 工具注册的确定性状态机
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 为什么单独抽成一个模块（2026-11-20）
 *
 *   原来这段逻辑内联在 `index.js` 的 `apply()` 闭包里。于是测试只有两条路：
 *     ① 用 `readFileSync` + 正则去匹配源码文本 —— 改个变量名就红，逻辑改错不红；
 *     ② 在测试文件里**重写一份副本**再测 —— 跟真代码毫无绑定，
 *        `index.js` 改坏了它照样绿。
 *   `tests/regress.mjs` 的第 59 组两样都干了，所以它一直是「假绿」。
 *
 *   抽成模块后，测试可以直接喂假 `ctx` / 假 `tools`，驱动**真实代码**。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 这里修掉的两个 bug（2026-11-20 评审确认）
 *
 *   bug ①「部分成功即全部成功」
 *     原逻辑用 `if (n > 0) registered = true`。7 个工具里 1 个抛普通错误、
 *     其余 6 个成功 → n=6 > 0 → 认定全部完成 → 定时器被清掉 →
 *     `registered` 挡住后续所有 `tools/change` 重试。
 *     结果：那个失败的工具**永久缺失**，日志却写「已注册 6 个」。
 *     修法：只有 `done` 覆盖**全部**定义名时才置 completed。
 *
 *   bug ②「未就绪也消耗次数 → 10 秒永久放弃」
 *     原逻辑在 `if (!tools?.register) return` **之前**就 `attempts++`。
 *     配 500ms 轮询 × MAX_ATTEMPTS=20，等于宿主 `tools` 服务 10 秒没就绪
 *     就永久放弃，而且这条路径**一行日志都不打**（静默 return）。
 *     后果比 bug ① 更严重：不是「部分工具缺失」，是**一个都没有**，
 *     日志干净得像正常启动。
 *     修法：`tools` 服务未就绪**不消耗**注册次数，单独计 `notReady`，
 *     并给它一个宽松得多的独立上限（默认 600 次 ≈ 5 分钟）。
 *
 * ────────────────────────────────────────────────────────────────
 * ⚠️ 「已存在」为什么算成功
 *
 *   `tools.register` 对已存在的名字**抛错**。而名字已经在工具表里，
 *   目标本来就达成了 —— 把它当失败会导致每轮全量重试到次数耗尽
 *   （2026-11-05 真机：56 行「already registered」）。
 *   所以 `isAlreadyRegistered(e)` 成立时记进 `done`，且**不写失败日志**。
 *
 *   ⚠️ 但**只有**这一种异常享受这个待遇。其他任何异常都算真失败，
 *   继续留在 missing 里等下一轮 —— 不许把「别的错」也当成功（那是 bug ① 的温床）。
 */

/** 默认最多真正尝试注册多少轮（每轮都试着补齐 missing）。 */
export const DEFAULT_MAX_ATTEMPTS = 20

/** 默认最多容忍多少轮「tools 服务还没就绪」。500ms × 600 ≈ 5 分钟。 */
export const DEFAULT_MAX_NOT_READY = 600

/** 「已存在」的判据：只认这条，不靠错误码。 */
export function isAlreadyRegistered(e) {
  return /already registered/i.test(String(e?.message ?? e))
}

/**
 * 创建一个工具注册器。
 *
 * @param {object} opts
 * @param {object} opts.ctx            Cordis 上下文（读 `ctx.get('tools')` / `ctx.effect` / `ctx.on`）
 * @param {(msg: string) => void} opts.log 日志函数（失败/放弃时都会写）
 * @param {() => Array<{name: string}>} opts.makeDefinitions 生成工具定义；只调用一次并缓存
 * @param {number} [opts.maxAttempts]      真注册轮次上限
 * @param {number} [opts.maxNotReadyAttempts] 「服务未就绪」轮次上限
 * @param {(n:number, total:number, attempts:number) => void} [opts.logCompleted]
 *        覆盖「全部注册完成」那条日志的写法。默认走 `log(...)`。
 *        存在的理由：`index.js` 有一个**模块级**闸门 `TOOLS_REGISTERED_LOGGED`
 *        （2026-11-05 真机：一次启动刷了 8 条一模一样的「已注册」），
 *        那个闸门必须跨实例共享才能压住，所以日志的写法要能由调用方接管。
 * @returns {{ tick: Function, start: Function, stop: Function, state: Function }}
 */
export function createToolRegistrar({
  ctx,
  log,
  makeDefinitions,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  maxNotReadyAttempts = DEFAULT_MAX_NOT_READY,
  logCompleted = null,
} = {}) {
  if (typeof makeDefinitions !== 'function') {
    throw new TypeError('createToolRegistrar: makeDefinitions 必须是函数')
  }

  /** 已确认可用的工具名（成功注册 或 「已存在」）。跨轮共享，避免重复 register。 */
  const done = new Set()

  /** 工具定义只在第一次生成时算一次，之后复用 —— 保证名字集合稳定。 */
  let definitions = null
  let defineError = null

  let attempts = 0          // 真正执行过注册动作的轮次
  let notReady = 0          // tools 服务未就绪的轮次
  let completed = false
  let gaveUp = false
  let completedLogged = false
  let gaveUpLogged = false

  /** 定时器句柄，start() 里创建，stop() 里清。 */
  let timer = null

  function getDefinitions() {
    if (definitions !== null || defineError !== null) return definitions ?? []
    try {
      const list = makeDefinitions()
      definitions = Array.isArray(list) ? list.filter((d) => d && typeof d.name === 'string') : []
    } catch (e) {
      defineError = e
      definitions = []
      log(`工具定义生成失败 :: ${e?.message ?? e}`)
    }
    return definitions
  }

  /** 还缺哪些名字（按定义顺序，便于阅读）。 */
  function missingNames() {
    return getDefinitions()
      .map((d) => d.name)
      .filter((n) => !done.has(n))
  }

  function snapshot() {
    const total = getDefinitions().length
    let status = 'idle'
    if (completed) status = 'complete'
    else if (gaveUp) status = 'gave-up'
    else if (notReady > 0 && attempts === 0) status = 'not-ready'
    else if (done.size > 0) status = 'partial'
    else status = 'idle'
    return {
      status,
      attempts,
      notReady,
      done: [...done],
      missing: missingNames(),
      total,
      completed,
      gaveUp,
    }
  }

  /**
   * 尝试一轮。
   *
   * 幂等：completed 或 gaveUp 之后直接返回快照，不再做任何事。
   */
  function tick() {
    if (completed || gaveUp) return snapshot()

    // ── ① 工具服务是否就绪 ──────────────────────────────
    //
    // ⚠️ 这一步**不能**消耗 attempts（bug ②）。服务没起来是我在等它，
    //   不是「我尝试注册失败了」。
    let tools = null
    try {
      tools = typeof ctx?.get === 'function' ? ctx.get('tools') : ctx?.tools
    } catch (e) {
      log(`读取 tools 服务异常 :: ${e?.message ?? e}`)
      tools = null
    }

    if (!tools?.register) {
      notReady++
      if (notReady >= maxNotReadyAttempts) {
        gaveUp = true
        if (!gaveUpLogged) {
          gaveUpLogged = true
          const miss = missingNames()
          log(
            `工具的 tools 服务始终未就绪（已等 ${notReady} 轮），放弃注册` +
              ` :: 缺失 ${miss.length ? miss.join(', ') : '(定义未生成)'}`,
          )
        }
        stopTimer()
      }
      return snapshot()
    }

    // ── ② 真正尝试注册 missing ──────────────────────────
    attempts++
    const defs = getDefinitions()
    if (defs.length === 0) {
      // 定义生成失败或为空：不算「完成」，但继续尝试也没意义，记一次就停
      gaveUp = true
      if (!gaveUpLogged) {
        gaveUpLogged = true
        log(`工具定义为空或生成失败，无法注册${defineError ? ` :: ${defineError?.message ?? defineError}` : ''}`)
      }
      stopTimer()
      return snapshot()
    }

    for (const def of defs) {
      if (done.has(def.name)) continue
      try {
        const dispose = tools.register(def)
        if (typeof ctx?.effect === 'function' && typeof dispose === 'function') {
          ctx.effect(() => dispose)
        }
        done.add(def.name)
      } catch (e) {
        if (isAlreadyRegistered(e)) {
          // 名字已在表里 = 目标达成，记账但不写失败日志
          done.add(def.name)
        } else {
          log(`工具注册失败 :: ${def.name} :: ${e?.message ?? e}`)
        }
      }
    }

    // ── ③ 是否全部完成（bug ① 的修法）────────────────────
    //
    // ⚠️ 判据是 `done` 覆盖**全部定义名**，不是 `n > 0`。
    //   部分成功时保持未完成，让 tools/change 与轮询继续补缺失项。
    if (missingNames().length === 0) {
      completed = true
      if (!completedLogged) {
        completedLogged = true
        if (typeof logCompleted === 'function') logCompleted(done.size, defs.length, attempts)
        else log(`mind_* 工具已注册 :: ${done.size}/${defs.length} 个（第 ${attempts} 次尝试）`)
      }
      stopTimer()
      return snapshot()
    }

    // ── ④ 次数耗尽 ──────────────────────────────────────
    //
    // ⚠️ 放弃时必须**明确写出缺哪些名字**（评审要求的可运维标准）。
    //   只写「注册失败」等于什么都没说。
    if (attempts >= maxAttempts) {
      gaveUp = true
      if (!gaveUpLogged) {
        gaveUpLogged = true
        const miss = missingNames()
        log(
          `工具注册放弃 :: 已尝试 ${attempts} 轮，仍未注册 ${miss.length} 个` +
            ` :: ${miss.join(', ')}`,
        )
      }
      stopTimer()
    }

    return snapshot()
  }

  function stopTimer() {
    if (timer !== null) {
      const t = timer
      timer = null
      try {
        clearInterval(t)
      } catch {
        // 清不掉也不影响正确性
      }
    }
  }

  /**
   * 挂上监听与轮询。
   *
   * ⚠️ 卸载清理的做法（2026-11-20 取证）：
   *   - `ctx.on(...)` **不需要**手动清 —— 读 `@deepseek-ai/cordis` 的
   *     `EventsService.register()`（asar 内 `lib/index.js:919-929`），
   *     它内部走 `this.ctx.fiber.effect(...)`，fiber 卸载时自动 unregister。
   *   - `setInterval` **必须**自己清，所以绑定到 `ctx.effect`，
   *     与本文件既有写法（`index.js` 里 configTimer 那处）一致。
   *
   * @param {{ pollMs?: number }} [opts]
   * @returns {() => void} stop
   */
  function start({ pollMs = 500 } = {}) {
    // 先跑一轮：宿主 tools 通常早已就绪，这一次就能全部注册完
    tick()

    if (!completed && !gaveUp) {
      // tools/change 触发时补缺失项（自动随 fiber 解绑，见上）
      try {
        ctx?.on?.('tools/change', () => tick())
      } catch (e) {
        log(`挂 tools/change 失败 :: ${e?.message ?? e}`)
      }

      timer = setInterval(() => tick(), pollMs)
      // 不要让定时器阻止进程退出
      if (typeof timer?.unref === 'function') timer.unref()
      // fiber 卸载时清掉定时器（否则插件重载会累积一串空转的 interval）
      try {
        ctx?.effect?.(() => () => stopTimer())
      } catch {
        // 没有 effect 能力时只能靠 stop() 显式清
      }
    }

    return stop
  }

  function stop() {
    stopTimer()
  }

  return { tick, start, stop, state: snapshot }
}
