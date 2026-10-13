/**
 * ============================================================================
 *  临时测试客户端（验证服务端广播是否正常）
 * ============================================================================
 *  用途：不想开浏览器的时候，用命令行起一个"假的客户端"，
 *        发一条拖拽消息，看看服务端日志里有没有广播给其它连接。
 *
 *  用法：
 *    终端1: node server/index.js          # 起服务端
 *    终端2: node server/test-client.js 100 200   # 连上去，发一条 drag
 *
 *  更真实的验证方式（两个假客户端互相同步）：
 *    终端2: node server/test-client.js 100 200
 *    终端3: node server/test-client.js 400 300   # 终端2 会打印收到终端3 的坐标
 *
 *  也可以用 wscat 手动玩：
 *    npx wscat -c ws://localhost:3000
 *    > {"type":"drag","x":123,"y":45}
 * ============================================================================
 */

import WebSocket from 'ws';
// 协议契约：测试客户端也按同一份 schema 收发。
// 顺便它充当协议文件的"第二个使用者"——前端和服务端之外还有一方在用，证明这份契约真的通用。
import {
  validateMessage,
  formatErrors,
  CLIENT_TO_SERVER,
  SERVER_TO_CLIENT,
} from '../shared/protocol.js';

const PORT = Number(process.env.WS_PORT) || 3000;
const url = `ws://localhost:${PORT}`;

// 命令行参数：node test-client.js <x> <y>，不给就用默认值
const x = Number(process.argv[2] ?? 222);
const y = Number(process.argv[3] ?? 111);

console.log(`[test-client] 连接 ${url} ...`);

// 浏览器里是 new WebSocket(url)，Node 里需要显式引入 ws 库，用法几乎一样
const ws = new WebSocket(url);

ws.on('open', () => {
  console.log('[test-client] ✅ 已连接');

  // 发送前先按协议自查一遍（比如命令行传了 "abc" 当坐标，Number() 会得到 NaN，在这里被拦下）
  const payload = { type: 'drag', x, y };
  const verdict = validateMessage(payload, CLIENT_TO_SERVER);
  if (!verdict.ok) {
    console.error(`[test-client] ❌ 消息不符合协议，不发 → ${formatErrors(verdict.errors)}`);
    process.exit(1);
  }

  console.log(`[test-client] -> 发送 drag (${x}, ${y})`);
  ws.send(JSON.stringify(payload));

  // 停 5 秒，留出时间让另一个测试客户端打印它收到的广播，然后自动退出
  setTimeout(() => {
    console.log('[test-client] 5 秒到，主动关闭连接（顺便验证服务端的 close 日志）');
    ws.close();
  }, 5000);
});

ws.on('message', (raw) => {
  // 这里打印出来的每一条，都是"别人"发起的动作 —— 也就是广播到我这儿的。
  // 先解析再按协议校验：校验不过说明服务端/协议/本文件三方有人没对齐，大声报出来。
  let msg;
  try {
    msg = JSON.parse(raw.toString());
  } catch {
    console.log('[test-client] <- 收到非 JSON:', raw.toString().slice(0, 80));
    return;
  }
  const verdict = validateMessage(msg, SERVER_TO_CLIENT);
  if (!verdict.ok) {
    console.error(`[test-client] ⚠️ 收到不符合协议的数据 → ${formatErrors(verdict.errors)}`);
    return;
  }
  console.log('[test-client] <- 收到:', raw.toString());
});

ws.on('close', () => {
  console.log('[test-client] 连接已关闭，退出');
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[test-client] ❌ 出错了:', err.message);
  console.error('         服务端起了吗？端口对吗？');
  process.exit(1);
});
