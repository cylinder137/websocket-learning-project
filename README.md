# WebSocket 跨端同步 · 拖圆（教学项目）

一个**用来看懂 WebSocket 的最小可用项目**：

> 在电脑 A 的画布上拖动这个圆，另一台设备 / 另一个浏览器标签页里的圆会**实时跟着动**。

不追求功能多，追求「每一行代码你都能讲清楚为什么」。所以：

- 后端用 **`ws`**（不是 socket.io）—— 你发的每一条消息就是真正的 WebSocket 帧，能看到原始 JSON；
- 前端用 **Vue 3 + Vite**，画布用原生 **`<canvas>`**，鼠标坐标换算、重绘都摆在明面上；
- 两侧都打了大量**中文注释**，重点解释"**为什么这么写**"（比如为什么服务端也要校验坐标、为什么用 `setTimeout` 而不是 `setInterval` 重连）；
- 页面上有一个**调试面板**：连接状态、本端 id、最近收到的每一条事件。学习阶段，能看见的东西比聪明的东西重要。

---

## 一、目录结构

```
websocket-drag-circle/
├─ package.json           # 后端依赖(ws) + 便捷脚本
├─ server/
│  ├─ index.js            # ⭐ 服务端：WebSocket 服务（单文件，重点看这个）
│  └─ test-client.js      # 命令行临时客户端（不开浏览器也能验证广播）
├─ web/                   # 前端（Vue3 + Vite）
│  ├─ package.json
│  ├─ vite.config.js      # 开发服务器配置（host/port 都在这里）
│  ├─ .env.example        # VITE_WS_URL 的写法说明（要改地址就看它）
│  ├─ index.html
│  └─ src/
│     ├─ main.js
│     ├─ App.vue          # ⭐ 画布 + 拖动 + 重绘
│     ├─ useSyncSocket.js # ⭐ WebSocket 连接管理（连接/收消息/发送/重连）
│     └─ style.css
├─ README.md              # 你正在看的这个
└─ .gitignore
```

三个 ⭐ 文件就是全部的知识点：`server/index.js`（服务端视角）、`useSyncSocket.js`（连接管理视角）、`App.vue`（业务视角）。

---

## 二、快速开始

**环境要求**：Node.js ≥ 18（本机实测 v24.20.0，npm 11.19.0）。

### 1. 装依赖（两个地方都要装）

```powershell
# ① 后端（项目根目录）
cd E:\personalProjects\websocket-drag-circle
npm install

# ② 前端
cd web
npm install
```

> ⚠️ **本机踩过的坑**：如果装完前端发现 `npm run dev` 报 `'vite' 不是内部或外部命令`，
> 说明 `devDependencies` 被跳过了。原因通常是环境变量 `NODE_ENV=production`，
> 或者 npm 配置里有 `omit=dev`（`npm config get omit` 可以确认）。
> 解决：`npm install --include=dev`（只影响这一次安装，不用改全局配置）。
> 用 `npm config get omit` 输出 `dev` 时就属于这种情况。

### 2. 起服务（开**两个**终端）

**终端 1 —— 后端 WebSocket 服务（端口 3000）**

```powershell
cd E:\personalProjects\websocket-drag-circle
npm run server
# 或：node server/index.js
# 换端口：$env:WS_PORT=4000; node server/index.js
```

看到这样的输出就算成功：

```
============================================================
✅ WebSocket 服务已启动
   WS 地址   : ws://localhost:3000
   局域网地址 : ws://<你的局域网IP>:3000   （手机/其它电脑用这个）
   健康检查   : http://localhost:3000/health
============================================================
等待客户端连接... (Ctrl+C 停止)
```

> 用 `WS_PORT` 而不是常见的 `PORT` 是故意的：`PORT` 这个名字太常见，容易被别的软件/系统预设成别的值，
> 到时候服务端会"不听话"地跑到别的端口上去，排查起来很费劲（本项目就真踩过）。

**终端 2 —— 前端开发服务器（端口 5180）**

```powershell
cd E:\personalProjects\websocket-drag-circle\web
npm run dev
```

```
  VITE v5.4.21  ready in 272 ms
  ➜  Local:   http://localhost:5180/
  ➜  Network: http://10.3.126.60:5180/     ← 手机用这个
```

然后浏览器打开 <http://localhost:5180/>。

> 为什么不是 Vite 默认的 5173？因为这台电脑上已经有一个别的项目占着 5173 了，
> 会导致 `localhost:5173` 和 `127.0.0.1:5173` 打开的是两个不同项目。所以本项目固定用 **5180**，
> 并且配了 `strictPort: true`（端口被占就直接报错，而不是"悄悄换个端口继续跑"——那种情况你会一直看到旧页面，却以为代码没生效）。

### 3. 生产构建（可选）

```powershell
cd web
npm run build      # 产物在 web/dist，纯静态文件，随便找个 http 服务托管都行
```

---

## 三、怎么验证"同步"真的生效了

### 方式 A：两个浏览器标签页（最快）

1. 打开 `http://localhost:5180/`；
2. 复制标签页（或再开一个窗口打开同一地址）；
3. 两个标签页的圆**初始位置一样**（连上时从服务端同步过来的）；
4. 在其中一个标签页按住画布拖动 → 另一个标签页的圆立刻跟着动。

调试面板上能看到：
- 拖动的那一端：圆变**绿**色，最近来源 `local`；
- 另一端：圆变**蓝**色（说明"这是从网络推过来的"），日志里出现 `<- drag x=... y=... (来自 #1)`。

### 方式 B：命令行临时客户端（不需要浏览器）

```powershell
# 终端 3
cd E:\personalProjects\websocket-drag-circle
node server/test-client.js 100 200      # 连上去，发一条 drag(100,200)
# 再开一个终端发另一条，前一个终端会打印出它收到的广播：
node server/test-client.js 400 300
```

也可以直接用 wscat 手动玩：

```powershell
npx wscat -c ws://localhost:3000
> {"type":"hello","text":"hi"}
> {"type":"drag","x":300,"y":150}      # 这一条会被广播给其它连接
```

### 方式 C：手机 / 另一台电脑（跨端同步）

1. 查本机局域网 IP：

   ```powershell
   ipconfig | findstr IPv4        # 例如 10.3.126.60（WLAN 那块网卡）
   ```

2. **前端不用改代码**：手机浏览器直接打开 `http://10.3.126.60:5180/`。
   因为 `App.vue` 里默认的地址是「**用打开页面的那台主机的 IP** + 3000 端口」：

   ```js
   const WS_URL = import.meta.env.VITE_WS_URL ||
     `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:3000`;
   ```

   手机访问 `10.3.126.60:5180`，它就会去连 `ws://10.3.126.60:3000` —— 正好是你电脑。
   （如果你写死成 `ws://localhost:3000`，手机上就会去连**手机自己**，必然连不上。这是个经典坑。）

3. 想手动指定地址时，创建 `web/.env.local`：

   ```
   VITE_WS_URL=ws://10.3.126.60:3000
   ```

   > 改完 `.env` **必须重启 `npm run dev`**：Vite 的环境变量是启动时注入的。
   > 另外 `VITE_` 前缀是必须的，没这个前缀的变量 Vite 不会暴露给前端代码（防止把密钥泄漏到浏览器）。

4. 手机连不上？按顺序排查：
   - 手机和电脑是不是**同一个 WiFi**（不要一个连 WiFi 一个连热点/有线）；
   - Windows 防火墙：第一次运行 Node 会弹"是否允许网络访问"，要选**允许**（专用网络）；
     如果当时点了取消，去「Windows 安全中心 → 防火墙和网络保护 → 允许应用通过防火墙」里把 Node.js 勾上；
   - 先让电脑上的浏览器能通（localhost 能同步），再排查网络；
   - 手机浏览器打开 `http://10.3.126.60:3000/health` 应该能看到一段 JSON，看不到就是网络/防火墙问题。

---

## 四、通信协议（前后端约定）

消息统一是 **JSON 字符串**，靠 `type` 字段区分。全部就这 4 种：

| 方向 | 消息 | 字段 | 说明 |
| --- | --- | --- | --- |
| 服务端 → 新客户端 | `init` | `x, y, id, online` | 连接时**单发**：当前圆的坐标 + 你的编号 + 在线人数 |
| 客户端 → 服务端 | `drag` | `x, y` | "我把圆挪到这儿了" |
| 服务端 → 其它客户端 | `drag` | `x, y, from, name` | 广播：某人的新坐标（带发送者编号） |
| 双向 | `hello` / `online` | `text` / `online` | 打招呼 / 在线人数变化，纯为了日志好读 |

---

## 五、代码逐段讲解

### 5.1 建立连接（前端 `useSyncSocket.js`）

```js
ws = new WebSocket(url);   // url 形如 ws://localhost:3000
```

就这一行。它背后发生的事：

1. 浏览器向 `http://localhost:3000` 发一个**普通的 HTTP 请求**，但带上 `Upgrade: websocket` 等头；
2. 服务端如果同意，回 `101 Switching Protocols`；
3. 从这一刻起，这条 TCP 连接**不再是 HTTP**，而是一个全双工的帧协议——双方随时可以互发消息。

所以 **WebSocket 和 HTTP 用的是同一个端口**，它不是"另一个服务"。本项目里 `server/index.js` 就是让一个 http server 监听 3000，再把 `upgrade` 请求交给 `ws` 处理，`/health` 这类普通请求仍然按 HTTP 返回。

⚠️ 常见错误：`new WebSocket()` 之后**立刻** `send()` 会报 *Still in CONNECTING state*。
必须等 `onopen` 之后才能发。这也是为什么所有发送都放在 `onopen` 里或之后。

### 5.2 四个事件回调（WebSocket 的全部 API 就这些）

```js
ws.onopen    = () => { /* 握手成功，可以发消息了 */ };
ws.onmessage = (event) => { /* 服务端推来的消息，event.data 是原始数据 */ };
ws.onclose   = (event) => { /* 连接断了（code=1000 正常，1006 异常）*/ };
ws.onerror   = (err)   => { /* 出错了；浏览器出于安全不给细节，判断逻辑一般放 onclose */ };
```

**和 HTTP 最本质的区别在这里**：HTTP 是"客户端问、服务端答"，服务端想主动通知你只能靠轮询；
WebSocket 是长连接，服务端**随时**能推消息给客户端 —— 同步拖圆的"另一端跟着动"就是 `onmessage` 实现的。

`event.data` 默认是字符串（或二进制）。所以：

```js
let msg;
try { msg = JSON.parse(event.data); }
catch { pushLog('收到非 JSON 数据'); return; }   // 坏数据不能把页面搞崩
```

### 5.3 发送

```js
ws.send(JSON.stringify({ type: 'drag', x, y }));
```

`send()` 只能发 **字符串 / ArrayBuffer / Blob / TypedArray**。
直接 `send({x:1})` 会变成字符串 `[object Object]`（或直接被忽略）——这就是为什么要 `JSON.stringify`。

发送前要判断状态，否则连接已断时 `send` 会抛错：

```js
if (!ws || ws.readyState !== 1 /* OPEN */) return false;
```

`readyState` 四个值：`0 CONNECTING`、`1 OPEN`、`2 CLOSING`、`3 CLOSED`。

### 5.4 服务端：状态 + 广播（`server/index.js`）

WebSocket 服务端自己**不知道"有哪些客户端"**，它只知道自己手里的每一条连接。所以必须自己维护一张表：

```js
const clients = new Map();   // key: WebSocket 实例, value: { id, name }
```

广播就是遍历这张表挨个 `send`：

```js
function broadcast(payload, excludeWs = null) {
  const text = JSON.stringify(payload);     // 只序列化一次，N 个连接复用
  for (const ws of clients.keys()) {
    if (ws === excludeWs) continue;
    if (ws.readyState === 1) { ws.send(text); count++; }
  }
}
```

**为什么 `excludeWs` 要排除发送者自己？**
前端用的是"乐观更新"——你拖的时候本地已经把圆画到新位置了。如果服务端再把同一条坐标发回来，
本端会重复处理一次，"最近事件"面板也会被自己的回声刷屏。

**如果想改成"全都广播"（包括自己）会怎样？** 也能跑，而且更符合"以服务端为权威"的思路，
代价是本端要加一句 `if (msg.from === myId) return` 来忽略回声。两种都行，理解区别比记住结论重要。

**必须处理的断开清理：**

```js
ws.on('close', () => {
  clients.delete(ws);        // 忘了这句 → 内存泄漏 + 广播一直往死连接写
  broadcast({ type: 'online', online: clients.size });
});
```

**新连接进来先发一次全量快照：**

```js
sendTo(ws, { type: 'init', x: state.x, y: state.y, id, online: clients.size });
```

这叫「**全量快照 + 增量变更**」：连上时告诉你"现在是什么样"，之后只发"什么变了"。
如果不发 `init`，半路加入的设备会停在初始值，然后别人一动它才突然跳过去。
（更复杂的系统会做"事件序号 + 断线重放"，原理就是这个的加强版。）

**服务端也要校验坐标：**

```js
state.x = Math.max(0, Math.min(1000, Math.round(x)));
```

前端已经限制过了，为什么后端还限？因为任何人都能绕过前端 —— 打开控制台敲一行
`ws.send(JSON.stringify({type:'drag',x:99999,y:-5}))` 就发出去了。
**服务端永远不能信任客户端送来的数据**，这是后端的铁律。

### 5.5 前端：乐观更新（`App.vue`）

```js
function moveTo(p, { broadcast }) {
  circle.x = p.x;                 // ① 先改本地
  circle.y = p.y;
  draw();                         // ② 立刻重绘 —— 用户马上看到结果
  if (broadcast) send({ type: 'drag', x: ..., y: ... });   // ③ 再告诉服务端
}
```

顺序很关键：**先画，再发**。因为拖拽是每帧都在动的高频交互，如果等一趟网络往返（几十上百毫秒）再动，
手感会明显发黏。这就是 **乐观更新（Optimistic UI）**：先假设会成功，直接展示结果。
代价是万一服务端修正了你的坐标，画面会被"打回原形"（本项目不会发生，但聊天软件里常见的
"消息发出去又突然变红"就是这个套路）。

收到远端消息时反过来 —— **只画不发**，否则两端会无限互推：

```js
onMessage((msg) => {
  if (msg.type === 'drag') {
    if (isDragging) return;      // 自己正在拖，就先不管别人（两个人在拖的冲突问题）
    circle.x = msg.x; circle.y = msg.y;
    lastSource.value = 'remote'; // 让圆变蓝，一眼看出"这是网络来的"
    draw();
  }
});
```

### 5.6 前端：canvas 坐标换算（最容易错的地方）

canvas 有**两套尺寸**：

- 内部尺寸：`<canvas width="640" height="420">`，绘图坐标以它为准；
- 显示尺寸：CSS 说了算（本项目 `width:100%`，所以手机上会被压缩）。

不一致时鼠标的 `clientX` 不能直接当画布坐标用，必须先算缩放比：

```js
const rect = canvas.getBoundingClientRect();
const scaleX = W / rect.width;                 // 画布像素 / CSS 像素
return {
  x: (evt.clientX - rect.left) * scaleX,
  y: (evt.clientY - rect.top)  * scaleY,
};
```

**限制在画布内**也不能只夹 `0 ~ W`，因为 `(x, y)` 是**圆心**：

```js
clamp(x, R, W - R)     // 圆心离边至少 R，圆才不会露出一半在画布外
```

鼠标事件挂到 `window` 上（而不是 canvas 上）是为了"拖出画布再松手"也能正确结束，
否则 `isDragging` 会一直是 `true`，回来继续动鼠标就会莫名其妙地拖 —— 这是很常见的 bug。

### 5.7 断线自动重连（`useSyncSocket.js`）

```js
ws.onclose = () => {
  status.value = 'closed';
  if (manualClose) return;     // 自己主动关的，不重连
  scheduleReconnect();
};

function scheduleReconnect() {
  if (retryTimer) return;                        // 已经在等着了，别重复安排
  retryTimer = setTimeout(() => { retryTimer = null; connect(); }, 2000);
}
```

**为什么用 `setTimeout` 递归，而不是 `setInterval`？**
`setInterval` 不看"上一次成没成"，时间一到就捅一次；如果重连本身很慢（比如服务端没起，
每次都要等连接超时），多个连接尝试会叠在一起互相打架。`setTimeout` 是"这次失败了才安排下一次"，
天然串行。生产环境还会做**指数退避**（1s、2s、4s、8s…），避免服务端刚重启就被所有客户端同时打爆。

`manualClose` 这个标记是为了区分"服务端挂了"和"我们主动关的"：
组件卸载时 `onUnmounted(close)` 关掉连接，这时候不该再去重连，否则会留下一个
看不见的后台连接一直占着服务端的广播名额。

### 5.8 服务端：心跳 ping/pong

`server/index.js` 里每 30 秒给所有连接发一次 `ping`，并检查上一次有没有回 `pong`：

```js
ws.isAlive = false;
ws.ping();                      // 浏览器会自动回 pong，不用你写代码
ws.on('pong', () => { ws.isAlive = true; });
```

为什么需要它？如果对端是"网线被拔了""手机进了电梯"这种**非正常断开**，
TCP 层可能几分钟甚至永远不报错，服务端会以为它还活着，广播白发给一个僵尸连接。
真实项目里必须有这一段。

---

## 六、接下来可以自己改什么（练手清单，从易到难）

1. **加节流**：现在 `mousemove` 每触发一次就发一条，一秒可能上百条。
   用时间戳限制成"最多 40ms 发一次"（`if (now - last < 40) return`），或者用
   `requestAnimationFrame` 把发送压到每帧一次。对比一下服务端日志的条数。
2. **加防抖**：拖动时只发起点终点，中间不发；松手时补一条结束消息。看两种策略的观感差异。
3. **加房间号**：URL 上带 `?room=A`，服务端用 `Map<roomId, Set<WebSocket>>` 分房间广播，
   这样两个不同的房间互不干扰。这是所有"多用户实时应用"的第一课。
4. **多人多圆**：每个客户端有自己的圆（用 `id` 区分），别人看到的是"所有在线的人的圆"——
   从"共享一个状态"变成"维护一个状态集合"，难度上一个台阶，但非常接近真实协作场景。
5. **加上名字和颜色**：连接时发 `{type:'join', name}`，服务端记录，圆上显示名字。
6. **JSON vs 二进制**：拖拽坐标只有两个小整数，用 JSON 每条要几十字节。
   试试用 `ArrayBuffer` 发两个 `Int16`（4 字节），看服务端日志、流量、
   以及"为什么二进制省流量但难调试"。
7. **权威服务端（加服务端回执）**：改成"服务端收到后广播给所有人（包括发送者）"，
   前端不再乐观更新，而是等回执。体验一下两种模式的延迟和一致性区别。
8. **断线期间的队列**：断线时把坐标存起来，重连成功后补发最后一条（想想为什么只补最后一条就够）。
9. **加一段本地记录**：把收到的每条消息写进数组，拖动结束后能"回放"别人的拖动轨迹。
10. **换成 socket.io 对比**：同样的功能用 socket.io 写一遍，然后对比：
    它的房间、自动重连、心跳都是现成的，但你也失去了"看到原始帧"的机会。
11. **加鉴权**：连接时带 token，服务端在 `upgrade` 阶段校验，不通过就拒绝握手。
12. **压测**：写个脚本开 200 个连接同时发坐标，看服务端的 CPU 和消息延迟（可以用 `autocannon` 或自己写）。

---

## 七、常见问题排查

| 现象 | 原因 / 解决 |
| --- | --- |
| 页面一直"连接中/已断开" | 后端没起（先看终端 1 有没有输出）；或端口不对；浏览器控制台 (F12) 会有 WebSocket 连接失败的报错 |
| `npm run dev` 报 `'vite' 不是内部或外部命令` | 前端依赖没装全，`npm install --include=dev` |
| 两个标签页初始位置不一样 | 正常情况应该一样（服务端 `init` 给的）。不一样说明有一端没连上，看状态灯 |
| 拖了对面不动，但自己是动的 | 对面没连上，或服务端日志里"广播给 0 个其它客户端"——说明确实只有你一个连接 |
| 端口被占用 | 后端换 `WS_PORT`；前端改 `vite.config.js` 的 `port`（注意也要改浏览器地址） |
| 手机连不上 | 见上文"方式 C"的排查顺序（同 WiFi → 防火墙 → 先用 `/health` 测试网络） |
| 中文在终端里显示乱码 | PowerShell 5.1 的老毛病（读 UTF-8 文件按 GBK 解码），文件本身没问题；`chcp 65001` 可缓解 |

---

## 八、本项目已做过的验证（2026-10-08）

- 后端 `npm install` 成功（`ws@8.x`），`node server/index.js` 正常监听 `0.0.0.0:3000`，`/health` 返回 `{"ok":true,...}`；
- 前端 `npm install` + `npm run build` 成功（`dist/index.html` + ~69 KB JS + 2.3 KB CSS），`npm run dev` 在 5180 正常服务；
- 两个命令行客户端验证广播：客户端 #2 连接时收到 #1 的坐标（`init x=111 y=222`），#2 发 `drag(400,300)` 后 #1 收到广播，服务端日志 `[>] 广播 drag(400,300) 给 1 个其它客户端`；
- 真实浏览器（Edge 无头）端到端验证：两个页面同时打开 → A 页拖动 → A 坐标 `511,104`，B 页坐标同步为 `511,104`，B 面板显示"最近来源 remote (来自 #3)"；
- 断线重连验证：杀掉服务端后页面显示"已断开（重连第 1 次）"，服务端恢复后第 2 次重试自动连上（约 4 秒内）。
