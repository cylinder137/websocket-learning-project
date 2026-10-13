/**
 * ============================================================================
 *  useSyncSocket —— 把"原生 WebSocket"包成一个 Vue 组合式函数
 * ============================================================================
 *  这个文件是前端的学习重点。它只做一件事：
 *    管理一条 WebSocket 连接的生命周期（连接 → 收消息 → 发送 → 断开 → 重连），
 *    并把结果暴露成响应式变量给界面用。
 *
 *  为什么抽成一个文件而不是写在 App.vue 里？
 *    因为"连接管理"和"画圆"是两件不相干的事。分开之后 App.vue 里只剩业务逻辑，
 *    想换后端地址、想加房间号，都只动这一个文件。
 * ============================================================================
 */

import { ref, computed, onUnmounted } from 'vue';

// 协议契约：收发都按 shared/protocol.schema.json 校验（和服务端共用同一份）。
// 本文件在 web/src/ 下，往上一层是 web/，再往上才是项目根 —— 所以是 ../../shared/。
// 校验器是手写的 mini 版，原理见 shared/protocol.js 的文件头注释。
import {
  validateMessage,
  formatErrors,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
} from '../../shared/protocol.js';

/**
 * @param url WebSocket 地址，形如 'ws://localhost:3000'
 *            （协议头是 ws:// 或加密的 wss://，不是 http://）
 */
export function useSyncSocket(url) {
  /* -------------------------------------------------------------------------
   * 状态（都是 ref，因为要驱动界面变化）
   * ---------------------------------------------------------------------- */

  /** 'connecting' | 'connected' | 'closed' —— 界面上的连接指示灯靠它 */
  const status = ref('connecting');

  /** 服务端发来的本端编号（init 消息里带）*/
  const myId = ref(null);

  /** 当前在线连接数 */
  const online = ref(0);

  /** 最近事件日志，最新的在最前面。界面右侧那个列表就是它 */
  const logs = ref([]);

  /** 断线重连的尝试次数，界面上显示出来方便观察 */
  const retryCount = ref(0);

  const connected = computed(() => status.value === 'connected');

  /* -------------------------------------------------------------------------
   * 内部变量（不是 ref，因为不需要被界面响应式追踪）
   * ---------------------------------------------------------------------- */

  let ws = null; // 当前这条 WebSocket 连接
  let retryTimer = null; // 重连定时器
  let manualClose = false; // 是不是"我们自己主动关的"（主动关就不该重连）
  const messageHandlers = []; // 业务层注册的消息处理函数

  /* -------------------------------------------------------------------------
   * 日志工具：往界面上写一行带时间戳的记录
   * ---------------------------------------------------------------------- */
  function pushLog(text) {
    const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    logs.value.unshift(`[${t}] ${text}`);
    if (logs.value.length > 12) logs.value.pop(); // 只留最近 12 条，防止无限增长
  }

  /* -------------------------------------------------------------------------
   * 一、建立连接
   * ---------------------------------------------------------------------- */
  function connect() {
    // 防卫：已经有活连接时就别重复连了（重连定时器和快速点击可能撞上）
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

    status.value = 'connecting';
    pushLog(`正在连接 ${url} ...`);

    // ⭐ 这一行就是"建立 WebSocket 连接"的全部代码。
    //    浏览器内部做的事：发一个 HTTP 请求带上 Upgrade: websocket 头，
    //    服务端回 101 之后，这条路就变成全双工的了 —— 双方可以随时互发消息。
    ws = new WebSocket(url);

    /* --- 1.1 onopen：连接建立（握手成功）---
     * 注意：**只有到这里之后才能 send()**。
     * 在 new WebSocket() 之后立刻 send 会报 "Still in CONNECTING state"。
     */
    ws.onopen = () => {
      status.value = 'connected';
      retryCount.value = 0;
      pushLog('✅ 已连接');
      // 主动打个招呼，主要是让服务端日志里能看到"这是前端 A 来了"
      send({ type: 'hello', text: '浏览器前端上线' });
    };

    /* --- 1.2 onmessage：收到服务端推来的消息 ---
     * 这是 WebSocket 和 HTTP 最大的区别：
     *   HTTP 是"我问一次你答一次"，服务端想主动找客户端只能靠轮询；
     *   WebSocket 是长连接，服务端**随时**可以推消息过来，就靠这个回调。
     */
    ws.onmessage = (event) => {
      // event.data 是服务端 send 的原始内容。协议约定是 JSON 字符串，
      // 且结构必须符合 shared/protocol.schema.json —— 第一步先解析，第二步校验。
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        pushLog(`⚠️ 收到非 JSON 数据: ${String(event.data).slice(0, 40)}`);
        return;
      }

      /* 入站校验：正常情况下服务端不会发坏数据，这里拦的是
       * "服务端改了协议而前端 schema 没跟上"的版本漂移 —— 让它第一时间暴露，而不是静默错下去。
       */
      const verdict = validateMessage(msg, SERVER_TO_CLIENT);
      if (!verdict.ok) {
        pushLog(`⚠️ 收到不符合协议的数据，已丢弃 → ${formatErrors(verdict.errors)}`);
        return;
      }

      // 顺手记一条日志，方便肉眼观察"到底收到了什么"（教学项目最重要的部分）
      const brief =
        msg.type === 'drag'
          ? `drag x=${msg.x} y=${msg.y}${msg.from ? ` (来自 #${msg.from})` : ''}`
          : `${msg.type}${msg.id ? ` id=${msg.id}` : ''}${msg.online ? ` 在线=${msg.online}` : ''}`;
      pushLog(`<- ${brief}`);

      // 通用字段处理：谁来都更新一下
      if (msg.type === 'init') {
        myId.value = msg.id; // 服务端给我的身份证号
        online.value = msg.online ?? 1;
      }
      if (msg.type === 'online') {
        online.value = msg.online ?? online.value;
      }

      // 再交给 App.vue 注册的业务处理函数（比如"把圆挪过去"）
      for (const handler of messageHandlers) handler(msg);
    };

    /* --- 1.3 onclose：连接断开 ---
     * 什么情况会触发？
     *   - 服务端挂了 / 重启了
     *   - 网络断了（注意：拔网线可能几十秒后才触发）
     *   - 代码里主动 close()
     * 断线不是"结束"，而是"该重连了"。
     */
    ws.onclose = (event) => {
      ws = null;
      status.value = 'closed';
      pushLog(`✖ 连接已断开 (code=${event.code})`);

      if (manualClose) {
        pushLog('（主动关闭，不重连）');
        return;
      }
      scheduleReconnect();
    };

    /* --- 1.4 onerror：出错了 ---
     * 常见错误：服务端没起（会立刻触发 error + close）。
     * 注意 onerror 里拿不到什么有用的信息（浏览器出于安全不给细节），
     * 真正的判断通常放在 onclose 里做。
     */
    ws.onerror = () => {
      pushLog('⚠️ 连接出错（服务端起了吗？地址对吗？）');
    };
  }

  /* -------------------------------------------------------------------------
   * 二、断线自动重连
   * -------------------------------------------------------------------------
   * 用「递归 setTimeout」而不是「setInterval」的原因：
   *   setInterval 不看上一次的结果就每 N 秒捅一次，如果连接建得很慢，
   *   会有好几个连接尝试叠在一起；setTimeout 是"这一次失败了才安排下一次"，
   *   天然串行，不会打架。
   *
   * 生产环境还会做"指数退避"（等 1s、2s、4s、8s…避免服务端刚重启就被打爆），
   * 这里固定 2 秒，够用且好理解。
   */
  function scheduleReconnect() {
    if (retryTimer) return; // 已经在等着了，别重复安排
    retryCount.value++;
    pushLog(`↻ ${2}s 后尝试第 ${retryCount.value} 次重连...`);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, 2000);
  }

  /* -------------------------------------------------------------------------
   * 三、发送消息
   * -------------------------------------------------------------------------
   * WebSocket.send() 的硬规则：**只能发字符串、ArrayBuffer/Blob/TypedArray**。
   * 直接 send 一个对象会得到 "[object Object]"（或被忽略），所以约定发 JSON 字符串。
   * 想对比二进制可以看 README 里的"接下来可以自己改什么"。
   */
  function send(obj) {
    if (!ws || ws.readyState !== 1 /* OPEN */) {
      // 没连上就静默丢弃 + 记一条日志。拖拽是高频率动作，
      // 断线期间攒着的坐标再补发也没意义（发过去也是过期的位置）。
      pushLog('⚠️ 未连接，消息未发送');
      return false;
    }

    /* 出站校验（出关检查）：发之前先对照协议自查一遍。
     * 好处：写错字段名/发错类型，报错出现在"写错的那一行附近"的日志里，
     * 而不是等到服务端拒收（或更糟——静默忽略）才发现，排查距离短得多。
     */
    const verdict = validateMessage(obj, CLIENT_TO_SERVER);
    if (!verdict.ok) {
      pushLog(`⚠️ 消息不符合协议，未发送 → ${formatErrors(verdict.errors)}`);
      return false;
    }

    ws.send(JSON.stringify(obj));
    return true;
  }

  /* -------------------------------------------------------------------------
   * 四、对外接口
   * ------------------------------------------------------------------------- */

  /** 注册业务层消息处理函数，返回一个"取消注册"的函数 */
  function onMessage(handler) {
    messageHandlers.push(handler);
    return () => {
      const i = messageHandlers.indexOf(handler);
      if (i >= 0) messageHandlers.splice(i, 1);
    };
  }

  /** 主动关闭（比如组件卸载时），并阻止自动重连 */
  function close() {
    manualClose = true;
    if (retryTimer) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
    ws?.close();
  }

  // 组件被销毁时一定要关连接，否则会留下一个"看不见的"后台连接继续占用服务端名额
  onUnmounted(close);

  // 调用 useSyncSocket 后立刻开始连接（也可以手动延后，这里教学项目就直接连）
  connect();

  return { status, connected, myId, online, logs, retryCount, send, onMessage, close };
}
