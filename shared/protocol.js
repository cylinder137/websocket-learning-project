/**
 * ============================================================================
 *  shared/protocol.js —— 协议的「装订车间」：加载 schema + 两端共用的校验器
 * ============================================================================
 *  它解决三个问题：
 *
 *  1. schema 文件是 .json，怎么被两边的 .js 代码加载？
 *     —— Node 的 ESM 规定：导入 JSON 必须用「import 属性」显式声明类型，
 *        即 `with { type: 'json' }`（老写法是 assert，已废弃）。
 *        前端由 Vite 负责转译，同样认识这个语法，所以两边能 import 同一个文件。
 *
 *  2. 校验逻辑谁来写？
 *     真实项目一般用 ajv 这类现成的 JSON Schema 校验库（功能全、性能好）。
 *     但教学项目讲究「什么都看得见」：引个库进去，校验就成了黑盒。
 *     所以这里手写了一个 mini 校验器，只支持本项目 schema 用到的关键字：
 *        type / const / required / properties / additionalProperties
 *     你在 protocol.schema.json 里看到的所有约束它都能校验；
 *     没用到的关键字（pattern、items…）会被静默忽略 —— 这也是它和 ajv 的差距所在。
 *
 *  3. 校验放在哪？
 *     四个关口，一个都不能少（调用处见各文件）：
 *        服务端收：只信 schema 不信客户端 —— 后端的铁律
 *        服务端发：契约是双向的，服务端自己也不能发出坏消息
 *        前端收：  防止服务端改了协议没同步，把前端带崩
 *        前端发：  发出去之前先自查，把问题拦在本端
 * ============================================================================
 */

// Node 要求 JSON 模块带上 import 属性；这也是一份「显式声明」的自我介绍：
// 告诉运行时"我要的是 JSON，别猜"。Vite 侧同样认识这个语法。
import protocolSchema from './protocol.schema.json' with { type: 'json' };

// 原样再导出 schema 文档，谁想看协议全文都可以拿到
export { protocolSchema as schema };

/* ---------------------------------------------------------------------------
 * 一、两个方向的「消息类型 → 子 schema」对照表
 * ---------------------------------------------------------------------------
 * 为什么不直接用整个 schema 校验？
 *   根部的 oneOf 是「六选一」，它只能告诉你"这不是任何一种合法消息"，
 *   却不能告诉你"你更像 drag，但缺了 y 字段"。
 *   按 msg.type 查表后用子 schema 精确校验，报错才能指到具体字段 —— 调试体验天壤之别。
 *
 * 注意名字说的是「消息的流向」，不是「使用者的身份」：
 *   服务端校验收到的消息用 CLIENT_TO_SERVER（因为消息来自客户端）；
 *   前端校验收到的消息用 SERVER_TO_CLIENT（因为消息来自服务端）。
 */
const defs = protocolSchema.definitions; // draft-07 里叫 definitions，2019-09 之后改名 $defs

/** 上行：客户端 → 服务端 */
export const CLIENT_TO_SERVER = {
  drag: defs.dragRequest,
  hello: defs.helloRequest,
};

/** 下行：服务端 → 客户端 */
export const SERVER_TO_CLIENT = {
  init: defs.initEvent,
  drag: defs.dragEvent,
  hello: defs.helloEvent,
  online: defs.onlineEvent,
};

/* ---------------------------------------------------------------------------
 * 二、mini 校验器
 * ---------------------------------------------------------------------------
 * 结果不抛异常，而是返回 { ok, errors }。
 * 为什么不 throw？—— "收到一条坏消息"是运行时的常态而不是异常，
 * 用返回值让调用方显式决定"丢弃 + 记日志"，比 try/catch 更能表达这个语义。
 */

/** JSON Schema 的 type 是一套固定名字，和 JS 的 typeof 对不齐（array/null），先做映射 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value; // 'string' | 'number' | 'boolean' | 'object' | ...
}

/** 校验单个值的类型。返回错误描述；null 表示没问题 */
function checkType(value, expected) {
  const actual = typeOf(value);
  // integer 是 number 的"子类型"：typeof 都是 'number'，所以先按 number 比对，
  // 再用 Number.isInteger 把范围收紧到整数（JSON 里 1.5 是合法 number，但不是 integer）
  const loose = expected === 'integer' ? 'number' : expected;
  if (actual !== loose) return `应为 ${expected}，实际是 ${actual}`;
  // JSON.parse 产不出 NaN/Infinity，但 JS 代码里手拼的对象可能带 —— number 顺手兜一下
  if (expected === 'number' && !Number.isFinite(value)) return '应为有限的 number，实际是 NaN/Infinity';
  if (expected === 'integer' && !Number.isInteger(value)) return `应为整数(integer)，实际是 ${value}`;
  return null;
}

/**
 * 递归校验 value 是否符合 schema。
 * @param path   出错时用来报位置的路径，根是 '$'，比如 '$.x'、'$.position.x'
 * @param errors 错误收集器（递归往里 push，最后统一返回）
 */
function checkAgainst(value, schema, path, errors) {
  // 1) type：类型不对就没必要再往里走了，直接返回
  if (schema.type) {
    const problem = checkType(value, schema.type);
    if (problem) {
      errors.push({ path, message: problem });
      return;
    }
  }

  // 2) const：值必须严格等于某个常量（协议里用它钉死 type 字段）
  if ('const' in schema && value !== schema.const) {
    errors.push({
      path,
      message: `应为常量 ${JSON.stringify(schema.const)}，实际是 ${JSON.stringify(value)}`,
    });
    return;
  }

  // 3) 对象专属三件套：required / properties / additionalProperties
  if (typeOf(value) === 'object') {
    // 3.1 required：必填字段一个都不能少
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push({ path, message: `缺少必填字段 "${key}"` });
    }

    // 3.2 properties：逐个字段递归往下校验
    const props = schema.properties ?? {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) checkAgainst(value[key], sub, `${path}.${key}`, errors);
    }

    // 3.3 additionalProperties: false —— 严格模式：协议没写的字段直接拒绝。
    //     这是契约的「白名单」性质：服务端加了新字段而前端没更新 schema 时，
    //     前端会立刻大声报错，而不是静默忽略 —— 协议漂移在第一时间暴露。
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) {
          errors.push({ path, message: `多余字段 "${key}"（协议未定义，拒绝）` });
        }
      }
    }
  }
}

/**
 * 校验一条消息。
 * @param msg       已经 JSON.parse 过的消息对象
 * @param direction CLIENT_TO_SERVER 或 SERVER_TO_CLIENT（按消息流向选）
 * @returns { ok: boolean, errors: Array<{ path: string, message: string }> }
 */
export function validateMessage(msg, direction) {
  // 顶层必须是普通对象（数组、字符串、数字都不行）
  if (typeOf(msg) !== 'object') {
    return { ok: false, errors: [{ path: '$', message: '消息顶层必须是 JSON 对象' }] };
  }

  // 按 msg.type 查表。查不到 = 未知消息类型 = 拒收
  const schema = direction[msg.type];
  if (!schema) {
    return {
      ok: false,
      errors: [
        {
          path: '$.type',
          message: `未知消息类型 "${String(msg.type)}"（本方向只认 ${Object.keys(direction).join(' / ')}）`,
        },
      ],
    };
  }

  const errors = [];
  checkAgainst(msg, schema, '$', errors);
  return { ok: errors.length === 0, errors };
}

/** 把错误数组拼成一行可读文本，方便直接塞进日志 */
export function formatErrors(errors) {
  return errors.map((e) => `${e.path} ${e.message}`).join('；');
}
