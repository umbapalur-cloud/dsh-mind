/**
 * dsh-tools 兼容层：把「作者侧扁平 parameters」编译成宿主认可的原始 JSON Schema。
 *
 * ## 为什么必须有这个文件（2026-11-17 血证）
 *
 * 两个记忆插件原来都直接 `tools.register(def)`，而 `def.parameters` 是
 * **作者侧 DSL**（`{ text: { type:'string', required:true } }`）。
 * 宿主 `defineTool()` 才会把它编译成
 *   `{ type:'object', properties:{...}, required:[...] }`，
 * 而 `register()` 和 `projectToolSchema()` **不会**补做这一步 ——
 * 于是模型拿到的 schema 没有根级 `type/properties/required`，
 * 参数等于不存在（本会话实测 12 个工具全是 `() => any`）。
 *
 * 我们不 import 宿主的 `defineTool`：
 *   1. 契约要求第三方插件零依赖，peer 里没有 `@deepseek-ai/dsh-tools`；
 *   2. 硬 import 会让离线测试（tests/*.mjs）跑不起来。
 * 所以这里用**完全相同**的编译规则本地实现一份，只覆盖本插件实际用到的子集：
 *   string / number / integer / boolean / array / object / json，
 * 以及 `description` 这类注解。
 *
 * ## 编译规则（对齐宿主 schema.ts 的 compilePropertyMap）
 *
 * - 根永远编译成 `{ type:'object', properties, required? }`；
 * - 每个属性的 `required: true` **收集到根级 `required` 数组**（不是留在属性里）；
 * - `required:false` / 缺省 → 不进数组；
 * - 作者侧不允许出现未知键（宿主会抛 authorError，这里同样抛）；
 * - 输出必须是无损 JSON（宿主 projectToolSchema 会 snapshot，函数/undefined 会抛）。
 *
 * 反例（不算做对）：
 *   ❌ 直接把 `parameters` 原样注册 —— 宿主不编译，参数丢失；
 *   ❌ 只在属性上加 `required:true` —— 根级没有 required，模型看到的是"全可选"；
 *   ❌ 编译后仍保留 `required` 在属性对象里 —— 那是非法关键字，宿主校验器会报错。
 */

/** 允许出现在属性上的 JSON Schema 类型。 */
const SIMPLE_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'json', 'null'])

/** 允许原样透传的注解键（宿主 ANNOTATION_KEYS 的子集）。 */
const ANNOTATION_KEYS = new Set(['description', 'title', 'default', 'examples', 'deprecated', 'readOnly', 'writeOnly'])

/** 编译期错误。宿主对应的是 authorError。 */
class SchemaAuthorError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SchemaAuthorError'
  }
}

const fail = (msg) => {
  throw new SchemaAuthorError(msg)
}

/**
 * 编译单个值 schema（属性值、数组 items、嵌套 object）。
 *
 * @param {unknown} input 作者侧值 schema
 * @param {string} path 报错用路径，例如 `parameters.text`
 * @returns {object} 原始 JSON Schema 节点
 */
function compileValueSchema(input, path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(`${path} 必须是对象形态的 schema`)
  }
  const type = input.type
  if (typeof type !== 'string' || !SIMPLE_TYPES.has(type)) {
    fail(`${path}.type 必须是 ${[...SIMPLE_TYPES].join('/')} 之一`)
  }
  const allowed = new Set([...ANNOTATION_KEYS, 'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
  for (const key of Object.keys(input)) {
    // `required` 只在本层是**属性声明**时才有意义，由 compilePropertyMap 消费，
    // 因此这里允许它出现但不会写进输出（见下面的 delete 语义）。
    if (!allowed.has(key)) fail(`${path}.${key} 不是受支持的键`)
  }

  const node = {}
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(input, key)) node[key] = input[key]
  }
  if (Object.hasOwn(input, 'enum')) {
    if (!Array.isArray(input.enum) || input.enum.length === 0) fail(`${path}.enum 必须是非空数组`)
    node.enum = [...input.enum]
  }
  if (Object.hasOwn(input, 'const')) node.const = input.const

  if (type === 'json') {
    // 宿主语义：只作注解，不施加约束（additionalProperties 交给根）。
    return node
  }

  node.type = type

  if (type === 'object') {
    if (typeof input.additionalProperties !== 'boolean') {
      fail(`${path}.additionalProperties 必须显式写 true 或 false`)
    }
    node.additionalProperties = input.additionalProperties
    if (Object.hasOwn(input, 'properties')) {
      const { properties, required } = compilePropertyMap(input.properties, `${path}.properties`)
      node.properties = properties
      if (required.length > 0) node.required = required
    }
  } else if (type === 'array') {
    if (Object.hasOwn(input, 'items')) node.items = compileValueSchema(input.items, `${path}.items`)
  }

  return node
}

/**
 * 编译属性映射：逐个值 schema 编译，并把 `required:true` 收集到根级数组。
 *
 * @param {unknown} map 作者侧 `{ 名字: 值schema }`
 * @param {string} path 报错路径
 * @returns {{properties: Record<string, object>, required: string[]}}
 */
function compilePropertyMap(map, path) {
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    fail(`${path} 必须是「属性名 → schema」的对象`)
  }
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(map)) {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
      fail(`${path}.${key} 必须是对象形态的 schema`)
    }
    // `required` 是属性级标记，编译时必须从值 schema 里剥掉，
    // 否则会变成非法关键字留在 properties 下。
    const { required: isRequired, ...valueSpec } = spec
    properties[key] = compileValueSchema(valueSpec, `${path}.${key}`)
    if (isRequired === true) required.push(key)
    else if (isRequired !== undefined && isRequired !== false) {
      fail(`${path}.${key}.required 只能是 true 或 false`)
    }
  }
  return { properties, required }
}

/**
 * 把作者侧扁平 parameters 编译成宿主 `ToolDefinition.parameters` 期望的形状。
 *
 * @param {Record<string, object>} parameters 作者侧参数表
 * @param {string} [toolName] 仅用于报错定位
 * @returns {{type:'object', properties: Record<string, object>, required?: string[]}}
 */
export function compileParameters(parameters, toolName = 'tool') {
  const map = parameters && typeof parameters === 'object' && !Array.isArray(parameters) ? parameters : {}
  const { properties, required } = compilePropertyMap(map, `${toolName}.parameters`)
  const schema = { type: 'object', properties }
  if (required.length > 0) schema.required = required
  return schema
}

/**
 * 编译一份工具定义（作者侧 DSL）→ 宿主可直接 register 的定义。
 *
 * 只改 `parameters`，其余字段（name/description/output/execute）原样透传，
 * 保持既有调用方式与测试断言不变。
 *
 * @param {object} def 作者侧工具定义
 * @returns {object} 编译后的工具定义
 */
export function compileToolDefinition(def) {
  if (!def || typeof def !== 'object') fail('工具定义必须是对象')
  if (typeof def.name !== 'string' || def.name.length === 0) fail('工具定义缺少 name')
  return { ...def, parameters: compileParameters(def.parameters, def.name) }
}

/** 供测试与排错使用：判断一份 parameters 是否已经是编译后的原始 JSON Schema。 */
export function isCompiledParameters(parameters) {
  return !!parameters && parameters.type === 'object' && !!parameters.properties && typeof parameters.properties === 'object'
}
