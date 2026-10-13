/**
 * ============================================================================
 *  WebSocket 同步服务端（教学版）
 * ============================================================================
 *
 *  这个文件只做三件事：
 *    1. 接受 WebSocket 连接，并给每个连接发一个「身份证号」(id)
 *    2. 记住圆的当前位置（服务端是唯一"真相源"），新连接进来就把这个坐标发给他
 *    3. 收到某个客户端发来的拖拽消息后，转发给**其它**客户端（广播）
 *
 *  ⚠️ 为什么用 `ws` 而不是 socket.io？
 *     socket.io 在原生 WebSocket 之上又加了一层自己的协议（握手、房间、自动降级轮询、
 *     自带重连）。用它对初学者来说"什么都自动了，但什么都看不见"。
 *     `ws` 就是裸的 RFC6455 实现：一行 ws.send() 发出去的就是一帧真正的 WebSocket 数据。
 *     学完之后再去看 socket.io 的源码，会发现它做的事你都能看懂。
 *
 *  运行：node server/index.js      （或 npm run server）
 *  端口：默认 3000，可用环境变量 WS_PORT 覆盖，例如：
 *        PowerShell:  $env:WS_PORT=4000; node server/index.js
 *        cmd:         set WS_PORT=4000 && node server/index.js
 *
 *  【为什么用 WS_PORT 而不是常见的 PORT？】
 *   PORT 这个名字太常见了，很多环境（Docker、各种框架、甚至某些系统）会预设它。
 *   本项目就实际遇到过：机器上环境变量里已经有 PORT=50800，结果服务端"没听话"
 *   地跑到了 50800 而不是 3000，排查半天。用项目专属的名字可以彻底避免这种撞车。
 * ============================================================================
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

// 协议契约（shared/protocol.schema.json）+ 两端共用的校验器。
// schema 文件放在项目根的 shared/ 下：前端（web/）和服务端（server/）加载的是同一份，
// 协议只有一份「宪法」，改字段时两边不可能再各说各话。
import { validateMessage, formatErrors, CLIENT_TO_SERVER, SERVER_TO_CLIENT } from '../shared/protocol.js';

const PORT = Number(process.env.WS_PORT) || 3000;

/* ---------------------------------------------------------------------------
 * 一、服务端保存的"全局状态"
 * ---------------------------------------------------------------------------
 * 现在只有圆一个东西，所以直接用一个对象存。
 * 关键理念：**所有客户端不各自为政，而是共享这一份状态**。
 * 客户端本地那份坐标只是为了"拖的时候不卡"，服务端这份才是权威。
 *
 * 如果以后要多个圆，就把它改成 new Map([[id, {x, y}], ...])。
 */
const state = { x: 150, y: 150 };

/* ---------------------------------------------------------------------------
 * 二、连接登记表
 * ---------------------------------------------------------------------------
 * 为什么要自己维护一张表？
 *   因为 ws 只管"这条连接"，它不知道"所有人是谁"，也就没法广播。
 *   广播 = 遍历这张表，挨个调 send()。
 *
 * 用 Map 而不是数组：断开连接时需要按对象直接找到并删除，Map.delete 是 O(1)。
 * value 里存 id 和昵称，方便日志里区分是哪一端。
 */
const clients = new Map(); // key: WebSocket 实例, value: { id, name }

let nextId = 1; // 自增编号，用作客户端 id

/**
 * 统一的消息发送函数。
 *
 * 【为什么必须有这个函数，而不是到处写 ws.send()】
 *   1. WebSocket.send() 只能发字符串或二进制（Buffer/TypedArray）。
 *      发对象会直接报错或被强转成 "[object Object]"，所以协议上我们约定用 JSON 文本。
 *   2. 连接可能已经处于 CLOSING / CLOSED 状态，这时 send() 会抛错，
 *      统一在这里判断 readyState 可以少写一堆 try/catch。
 *   3. 以后想加"消息编号/时间戳"之类的公共字段，只改这一个地方。
 *
 * ws.OPEN === 1，也可以用常量 WebSocket.OPEN，这里用数字 1 并注释清楚。
 */
function sendTo(ws, payload) {
  if (ws.readyState !== 1 /* WebSocket.OPEN */) return; // 连接已关闭，丢弃

  /* 出站校验：契约是双向的。
   * 入站校验防"客户端发坏消息"，出站校验防"服务端自己写出不合协议的代码"。
   * 这是廉价保险：哪天有人改协议改漏了，日志会立刻指向发出处，而不是让前端的
   * "收到不符合协议"日志替你背锅。
   */
  const verdict = validateMessage(payload, SERVER_TO_CLIENT);
  if (!verdict.ok) {
    console.error(`[!] 拒绝发送不符合协议的消息 → ${formatErrors(verdict.errors)}`, payload);
    return;
  }
  ws.send(JSON.stringify(payload));
}

/**
 * 广播消息。
 *
 * @param payload 要发的对象
 * @param excludeWs 排除的客户端（一般是"消息的发送者自己"）
 *
 * 【为什么要 exclude 掉自己？】
 *   因为前端用的是"乐观更新"：拖动时本地立刻就把圆画到新位置了，
 *   如果服务端再把同一条消息发回来，本地会重复处理一次，也会让"最近事件"
 *   面板刷出自己刚发的消息，看起来像回声。
 *   排除自己 → 本地画完去通知别人，别人画，互不打扰。
 *
 * 【如果改成"全都发"（包括自己）会怎样？】
 *   也行，甚至更严谨（以服务端为准的"权威模式"），代价是本端会收到回声，
 *   需要前端额外判断 msg.from === myId 来忽略。教学上先选更直观的"发给其他人"。
 */
function broadcast(payload, excludeWs = null) {
  // 出站校验同 sendTo（注释见那里）；广播在循环前拦一次，比 N 个连接各拦一次划算
  const verdict = validateMessage(payload, SERVER_TO_CLIENT);
  if (!verdict.ok) {
    console.error(`[!] 拒绝广播不符合协议的消息 → ${formatErrors(verdict.errors)}`, payload);
    return 0;
  }

  const text = JSON.stringify(payload);
  let count = 0;
  for (const ws of clients.keys()) {
    if (ws === excludeWs) continue;
    if (ws.readyState === 1) {
      ws.send(text); // 已经 stringify 过一次，这里直接复用，避免 N 次序列化
      count++;
    }
  }
  return count;
}

/* ---------------------------------------------------------------------------
 * 三、HTTP + WebSocket 共用一个端口
 * ---------------------------------------------------------------------------
 * 很多人以为 WebSocket 是"另一个端口上的另一种服务"，其实不是：
 * WebSocket 连接的建立过程叫 HTTP Upgrade —— 客户端先发一个带
 * `Connection: Upgrade` / `Upgrade: websocket` 头的普通 HTTP 请求，
 * 服务端回 101 Switching Protocols，之后这条 TCP 连接就从 HTTP 协议
 * 切换成了一个全双工的帧协议。
 *
 * 所以我们可以让 http 服务器来监听端口，把"升级"事件交给 ws 处理；
 * 没带升级头的普通请求（比如浏览器直接打开 http://localhost:3000/）
 * 就由我们自己返回一句话，方便在浏览器里确认"服务活着"。
 */
const server = http.createServer((req, res) => {
  // 这是一个普通的 HTTP 请求（不是 WebSocket）。
  // 提供一个极简的健康检查，方便排查"服务到底起没起"。
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, clients: clients.size, state }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(
    `WebSocket 同步服务正在运行。\n` +
      `WS 地址: ws://localhost:${PORT}\n` +
      `当前连接数: ${clients.size}\n` +
      `健康检查: http://localhost:${PORT}/health\n`
  );
});

// `server` 选项 = "把 HTTP 服务器收到的 upgrade 请求交给我处理"
// （等价写法是 new WebSocketServer({ port: 3000 })，那样 ws 会自己再建一个 http server，
//   就没法复用 /health 这个路由了）
const wss = new WebSocketServer({ server });

/* ---------------------------------------------------------------------------
 * 四、连接的生命周期：connection / message / close / error
 * ---------------------------------------------------------------------------
 * 这四个事件就是服务端要处理的全部。看懂这四个，WebSocket 服务端就通了。
 */
wss.on('connection', (ws, req) => {
  // 每个连接分配一个 id，并登记到表里
  const id = nextId++;
  const name = `client-${id}`;
  clients.set(ws, { id, name });

  // req.socket.remoteAddress 能看到对端 IP，调试局域网/多设备时非常有用
  const ip = req.socket.remoteAddress;
  console.log(`\n[+] 新连接 ${name}  id=${id}  ip=${ip}  当前在线=${clients.size}`);

  /* --- 4.1 新连接的第一件事：把当前状态单发给它 ---
   * 为什么只在连接时发一次？
   *   因为"当前坐标"是个状态（state），后面所有变化都会以增量消息(drag)推给它。
   *   先发 init 保证它一上来看到的就是正确的画面，而不是初始值再突然跳一下。
   *   这是状态同步最朴素的思路：全量快照 + 增量变更。
   */
  sendTo(ws, {
    type: 'init',
    x: state.x,
    y: state.y,
    id,               // 告诉它"你是谁"，前端用来显示 & 区分回声
    online: clients.size,
  });

  // 顺便告诉"其他人"有人加入了（前端可以显示在线人数；不做也不影响功能）
  broadcast({ type: 'online', online: clients.size, from: id }, ws);

  /* --- 4.2 收到消息 ---
   * 注意 onmessage 的参数是原始数据（字符串或 Buffer），不是一个已经解析好的对象。
   * 协议格式需要我们自己约定：约定写在 shared/protocol.schema.json（消息永远是 JSON 文本，
   * 且结构/类型必须符合 schema），收和发两头都按它校验。
   */
  ws.on('message', (raw, isBinary) => {
    const text = isBinary ? raw.toString() : raw.toString('utf8');
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      // 解析失败不能把服务干掉（一个坏客户端不能拖垮所有人）
      console.warn(`[!] ${name} 发来的不是合法 JSON，已忽略:`, text.slice(0, 120));
      return;
    }

    /* 协议校验（入站关口）：结构/类型必须符合 shared/protocol.schema.json。
     * 原来这里手写了 Number.isFinite 检查，现在这类"长得对不对"的问题全部交给
     * schema 统一把关，报错还能精确到字段。未知消息类型也在这里被拦下，走不到下面的 if 分发。
     */
    const verdict = validateMessage(msg, CLIENT_TO_SERVER);
    if (!verdict.ok) {
      console.warn(`[!] ${name} 的消息不符合协议，已拒收 → ${formatErrors(verdict.errors)}`);
      return;
    }

    console.log(`[<] ${name} ->`, msg);

    if (msg.type === 'drag') {
      /* 走到这里 x/y 一定是 number（schema 已保证类型）。
       * 剩下的 clamp 是"业务规则"而不是"类型校验"，两者分工不同：
       *   schema 校验是非黑即白的 —— 不合格就整条拒收；
       *   但坐标"超没超界"适合修正 —— 夹回画布内继续用，而不是丢掉。
       *   （拖拽丢一条消息圆就会"瞬移"，修正比拒收的手感好得多。）
       * 为什么要再校验一次？因为 WebSocket 是双向的，任何客户端都能伪造消息
       * （浏览器控制台一行 ws.send 就绕过了前端校验）—— 服务端永远不能信任客户端的数据。
       * 同时服务端保存的 state 是权威值，后续新连接拿到的 init 必须是合法的。
       */
      state.x = Math.max(0, Math.min(1000, Math.round(msg.x)));
      state.y = Math.max(0, Math.min(1000, Math.round(msg.y)));

      // 广播给其它人：把 from 带上，前端可以显示"这条是谁推来的"
      const n = broadcast(
        { type: 'drag', x: state.x, y: state.y, from: id, name },
        ws // 排除发送者自己，见 broadcast 的注释
      );
      console.log(`[>] 广播 drag(${state.x},${state.y}) 给 ${n} 个其它客户端`);
      return;
    }

    if (msg.type === 'hello') {
      // 前端连上后打个招呼，主要作用是让服务端日志更可读
      broadcast({ type: 'hello', from: id, name, text: msg.text ?? '' }, ws);
      return;
    }

    console.log(`[?] 未知消息类型: ${msg.type}`);
  });

  /* --- 4.3 连接关闭 ---
   * 一定要在这里把它从 clients 里删掉！
   * 否则这张表会越来越长（内存泄漏），而且广播时会一直往死连接上写。
   */
  ws.on('close', (code, reasonBuf) => {
    clients.delete(ws);
    console.log(
      `[-] 断开 ${name}  code=${code}  reason=${reasonBuf?.toString() || ''}  剩余在线=${clients.size}`
    );
    broadcast({ type: 'online', online: clients.size, left: id });
  });

  /* --- 4.4 错误 ---
   * 必须监听 error，否则一个异常（比如对方强杀进程导致的 ECONNRESET）
   * 会以未捕获异常的形式把整个 Node 进程干掉。
   */
  ws.on('error', (err) => {
    console.error(`[!] ${name} 连接错误:`, err.message);
  });

  /* --- 4.5 心跳（ping/pong）---
   * 背景：如果对方是"网线被拔了""手机进了电梯"这种非正常断开，
   *       TCP 层可能要几分钟甚至永远不报错，服务端会以为它还活着。
   * 做法：服务端每 30 秒 ping 一次，客户端/浏览器会自动回 pong；
   *       我们在 close 之外再用一个标记记录"上次是否回过 pong"，两次没回就主动踢掉。
   *
   * 这个项目里不做也不影响功能（断网那端反正也收不到消息了），
   * 但真实项目里必须有，否则"幽灵连接"会一直占着广播名额。
   * 这里就把标记挂上去，演示原理，逻辑保持最简。
   */
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
});

/* 服务端侧的定时 ping：真正项目里写，但下面这段是完整可用的 */
const heartbeat = setInterval(() => {
  for (const ws of clients.keys()) {
    if (ws.isAlive === false) {
      console.log('[!] 心跳超时，主动断开一个僵尸连接');
      ws.terminate(); // terminate 是立刻断，比 close() 更狠，用于确认无响应的连接
      continue;
    }
    ws.isAlive = false; // 先假设它死了，收到 pong 再改回 true
    ws.ping();
  }
}, 30_000);

// 进程退出时清理定时器（Ctrl+C 时不留悬挂的 timer）
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log(`✅ WebSocket 服务已启动`);
  console.log(`   WS 地址   : ws://localhost:${PORT}`);
  console.log(`   局域网地址 : ws://<你的局域网IP>:${PORT}   （手机/其它电脑用这个）`);
  console.log(`   健康检查   : http://localhost:${PORT}/health`);
  console.log('='.repeat(60));
  console.log('等待客户端连接... (Ctrl+C 停止)');
});

// 端口被占用之类的错误，给一个能看懂的提示，而不是一坨堆栈
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`❌ 端口 ${PORT} 已被占用。换个端口：$env:WS_PORT=4000; node server/index.js`);
  } else {
    console.error('❌ 服务启动失败:', err);
  }
  process.exit(1);
});
