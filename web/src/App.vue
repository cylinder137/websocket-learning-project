<script setup>
/**
 * ============================================================================
 *  App.vue —— 画布 + 拖动 + 同步
 * ============================================================================
 *  分工：
 *    这个文件负责"画"和"鼠标/手指事件"。
 *    真正的 WebSocket 收发在 useSyncSocket.js 里，用 onMessage/send 对接。
 *
 *  数据流（记住这一条就懂 WebSocket 同步了）：
 *    本端拖动 → ①本地立刻改坐标并重绘（乐观更新，保证手感不卡）
 *              → ②ws.send 把新坐标告诉服务端
 *              → ③服务端广播给其他端 → ④其他端收到后改坐标重绘
 * ============================================================================
 */

import { ref, reactive, onMounted } from 'vue';
import { useSyncSocket } from './useSyncSocket';

/* ---------------------------------------------------------------------------
 * 1. 一些常量
 * ------------------------------------------------------------------------ */
const W = 640; // 画布的逻辑宽度（= canvas 元素的 width 属性，单位是"画布像素"）
const H = 420; // 逻辑高度
const R = 36; // 圆的半径

// ⭐ 后端地址。
//    import.meta.env.VITE_WS_URL 来自 web/.env.local（Vite 只注入 VITE_ 开头的变量）。
//    没配就用默认值，方便"克隆下来就能跑"。
//    ⚠️ 用手机测的时候这里必须是电脑的局域网 IP（ws://192.168.x.x:3000），
//       写 localhost 的话手机会去连手机自己，必然失败。
const WS_URL =
  import.meta.env.VITE_WS_URL ||
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:3000`;
// 上面这行的意思是：默认连"打开页面的那台机器"的 3000 端口。
// 这样你在本机开 localhost:5173 就连 localhost:3000；
// 手机通过 192.168.1.100:5173 打开页面就连 192.168.1.100:3000，不用改代码。

/* ---------------------------------------------------------------------------
 * 2. 接入 WebSocket
 * ------------------------------------------------------------------------ */
const { status, myId, online, logs, retryCount, send, onMessage } = useSyncSocket(WS_URL);

/* ---------------------------------------------------------------------------
 * 3. 圆的状态
 * ------------------------------------------------------------------------ */
const canvasEl = ref(null);

// 圆的中心坐标。用 reactive 包一下，模板里能直接读到（虽然我们主要靠手动重绘）
const circle = reactive({ x: W / 2, y: H / 2 });

// 这个坐标最后一次是谁改的：'local' 自己拖的 / 'remote' 别人推来的 / 'init' 连接时同步的
// 只用来给圆换个颜色，方便肉眼确认"这条是从网络来的"
const lastSource = ref('init');
let lastFrom = null; // 最近一次远端消息是谁发的（显示用）

let isDragging = false; // 当前是否按住鼠标/手指

/* ---------------------------------------------------------------------------
 * 4. 画布绘制
 * ------------------------------------------------------------------------ */

/**
 * 把圆画出来。每次坐标变化都调一次（教学项目不做增量渲染，全量重绘最简单）。
 */
function draw() {
  const ctx = canvasEl.value?.getContext('2d');
  if (!ctx) return;

  // 4.1 清屏（Canvas 不是"有对象记忆"的矢量图，不清屏就会留下上一次的圆）
  ctx.clearRect(0, 0, W, H);

  // 4.2 背景网格：纯粹为了好看，同时能直观看出坐标换算对不对
  ctx.strokeStyle = '#1e293b';
  ctx.lineWidth = 1;
  for (let x = 0; x <= W; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, H);
    ctx.stroke();
  }
  for (let y = 0; y <= H; y += 40) {
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(W, y + 0.5);
    ctx.stroke();
  }

  // 4.3 颜色随来源变化：绿色=你拖的，蓝色=远端推来的，灰色=初始同步
  const color =
    lastSource.value === 'local' ? '#22c55e' : lastSource.value === 'remote' ? '#3b82f6' : '#94a3b8';

  // 4.4 画圆
  ctx.save();
  ctx.shadowColor = color;
  ctx.shadowBlur = 18; // 发光效果，拖动时很明显
  ctx.beginPath();
  ctx.arc(circle.x, circle.y, R, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();

  // 4.5 圆上加一条白色高光圈，看起来更像球
  ctx.beginPath();
  ctx.arc(circle.x - R * 0.3, circle.y - R * 0.3, R * 0.35, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.35)';
  ctx.fill();

  // 4.6 在圆中心写坐标，方便对照服务端日志
  ctx.fillStyle = '#0f172a';
  ctx.font = 'bold 13px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${Math.round(circle.x)},${Math.round(circle.y)}`, circle.x, circle.y);
}

/* ---------------------------------------------------------------------------
 * 5. 坐标换算 —— canvas 项目里最容易踩坑的地方
 * ------------------------------------------------------------------------ */

/**
 * 把浏览器的"屏幕坐标"换算成"画布内部坐标"。
 *
 * 为什么必须换算？
 *   画布有两套尺寸：
 *     - 内部尺寸：canvas 元素的 width/height 属性（这里是 640×420），绘图坐标以它为准
 *     - 显示尺寸：CSS 里的实际显示大小（响应式布局下可能被压缩成 400px 宽）
 *   两套尺寸不一致时，鼠标的 clientX 是"屏幕像素"，直接拿来当画布坐标会整体偏移。
 *   所以要先算缩放比 scale，再乘回去。
 */
function toCanvasPoint(evt) {
  const rect = canvasEl.value.getBoundingClientRect();
  const scaleX = W / rect.width;
  const scaleY = H / rect.height;
  return {
    x: (evt.clientX - rect.left) * scaleX,
    y: (evt.clientY - rect.top) * scaleY,
  };
}

/**
 * 把坐标夹在画布内，保证整个圆都不越界。
 * 不是 0~W，而是 R~W-R：因为 (x,y) 是圆心，圆心离边 R 才是圆刚好贴边。
 * 服务端也会做一次同样的限制 —— 因为服务端不能信任客户端发来的数据。
 */
function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}
function clampPoint(p) {
  return {
    x: clamp(p.x, R, W - R),
    y: clamp(p.y, R, H - R),
  };
}

/* ---------------------------------------------------------------------------
 * 6. 拖动交互
 * ------------------------------------------------------------------------ */

function startDrag(evt) {
  evt.preventDefault?.(); // 手机上阻止默认的滚动/长按选中
  isDragging = true;
  // 点哪儿圆就到哪儿（比"必须精确按住圆"手感好得多）。
  // 想改成"只有按在圆里才能拖"的话，判断 (p.x-circle.x)² + (p.y-circle.y)² <= R² 即可。
  const p = clampPoint(toCanvasPoint(evt));
  moveTo(p, { broadcast: true });

  // 把 move/up 挂到 window 上：这样鼠标拖出画布范围时仍然能被追踪到，
  // 松手也能正确结束（否则拖出去一松手，isDragging 会一直是 true，像卡住了）
  window.addEventListener('mousemove', onWindowMove);
  window.addEventListener('mouseup', endDrag);
  window.addEventListener('touchmove', onWindowTouchMove, { passive: false });
  window.addEventListener('touchend', endDrag);
}

function onWindowMove(evt) {
  if (!isDragging) return;
  moveTo(clampPoint(toCanvasPoint(evt)), { broadcast: true });
}

function onWindowTouchMove(evt) {
  if (!isDragging) return;
  evt.preventDefault(); // 阻止页面跟着手指滚动
  const t = evt.touches[0];
  if (!t) return;
  moveTo(clampPoint(toCanvasPoint(t)), { broadcast: true });
}

function endDrag() {
  if (!isDragging) return;
  isDragging = false;
  lastSource.value = 'local';
  draw();
  window.removeEventListener('mousemove', onWindowMove);
  window.removeEventListener('mouseup', endDrag);
  window.removeEventListener('touchmove', onWindowTouchMove);
  window.removeEventListener('touchend', endDrag);
}

/**
 * 移动圆的统一入口。
 *
 * @param p {x, y} 已经 clamp 过的新坐标
 * @param broadcast 是否要发给服务端（收到远端消息时用的是"只画不发"，否则会无限互推）
 *
 * ⭐ 注意这里的顺序：**先改本地、先重绘，再 send**。
 *    这就是"乐观更新"（Optimistic UI）：不等服务端确认就先让用户看到结果。
 *    因为拖拽是高频交互（每帧都在动），如果等一趟网络往返再动，手感会明显发黏。
 *    代价是服务端可能拒绝/修正你的坐标（本教学项目里不会），届时画面会被纠正回来。
 */
function moveTo(p, { broadcast }) {
  circle.x = p.x;
  circle.y = p.y;
  lastSource.value = 'local';
  draw();

  if (broadcast) {
    send({
      type: 'drag',
      // 取整可以显著减小消息体积（拖拽每秒几十条，能省则省）
      x: Math.round(p.x),
      y: Math.round(p.y),
    });
  }
}

/* ---------------------------------------------------------------------------
 * 7. 处理服务端推来的消息
 * ------------------------------------------------------------------------ */

onMessage((msg) => {
  if (msg.type === 'init') {
    // 刚连上：用服务端的权威坐标初始化，这样"半路加入"也能看到正确的画面
    circle.x = msg.x;
    circle.y = msg.y;
    lastSource.value = 'init';
    draw();
    return;
  }

  if (msg.type === 'drag') {
    // 我自己正在拖的时候忽略远端消息：
    // 两个人同时拖会互相打架（这叫冲突，真实项目里要设计"谁优先"的规则，
    // 本教学项目按需求只做基础处理，直接忽略即可）。
    if (isDragging) return;

    circle.x = msg.x;
    circle.y = msg.y;
    lastSource.value = 'remote';
    lastFrom = msg.from ?? null;
    draw(); // 重绘 → 这一瞬间你能看到别人的拖动
  }
});

/* ---------------------------------------------------------------------------
 * 8. 首次渲染
 * ------------------------------------------------------------------------ */
onMounted(draw);
</script>

<template>
  <div class="page">
    <header class="bar">
      <h1>🖱️ WebSocket 跨端同步 · 拖圆</h1>
      <div class="status" :class="status">
        <span class="dot"></span>
        <span v-if="status === 'connected'">已连接</span>
        <span v-else-if="status === 'connecting'">连接中…</span>
        <span v-else>已断开（重连第 {{ retryCount }} 次）</span>
      </div>
    </header>

    <div class="layout">
      <!-- 左边：画布 -->
      <section class="canvas-card">
        <canvas
          ref="canvasEl"
          :width="W"
          :height="H"
          @mousedown="startDrag"
          @touchstart="startDrag"
        ></canvas>
        <p class="hint">
          按住画布拖动 → 另一个标签页 / 另一台设备的圆会同步移动。
          <br />
          <span class="legend local">绿 = 我刚拖的</span>
          <span class="legend remote">蓝 = 远端推来的</span>
          <span class="legend init">灰 = 连接时同步的</span>
        </p>
      </section>

      <!-- 右边：调试面板（学习 WebSocket 全靠它） -->
      <aside class="panel">
        <div class="kv">
          <span>连接状态</span><b>{{ status }}</b>
        </div>
        <div class="kv">
          <span>本端 id</span><b>#{{ myId ?? '-' }}</b>
        </div>
        <div class="kv">
          <span>在线连接</span><b>{{ online }}</b>
        </div>
        <div class="kv">
          <span>圆坐标</span><b>{{ Math.round(circle.x) }}, {{ Math.round(circle.y) }}</b>
        </div>
        <div class="kv">
          <span>最近来源</span>
          <b>{{ lastSource }}<template v-if="lastFrom"> (来自 #{{ lastFrom }})</template></b>
        </div>
        <div class="kv">
          <span>WS 地址</span><b class="small">{{ WS_URL }}</b>
        </div>

        <h2>最近事件（实时）</h2>
        <ul class="logs">
          <!-- 这些日志是理解 WebSocket 最直观的证据：<- 是收到，其他的都是本地动作 -->
          <li v-for="(line, i) in logs" :key="i">{{ line }}</li>
          <li v-if="!logs.length" class="empty">还没有事件…</li>
        </ul>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.page {
  max-width: 1080px;
  margin: 0 auto;
  padding: 20px;
}
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
h1 {
  font-size: 20px;
  margin: 0;
}
.status {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  padding: 6px 14px;
  border-radius: 999px;
  background: #1e293b;
  border: 1px solid #334155;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #94a3b8;
}
.status.connected .dot {
  background: #22c55e;
  box-shadow: 0 0 8px #22c55e;
}
.status.connecting .dot {
  background: #f59e0b;
}
.status.closed .dot {
  background: #ef4444;
}

.layout {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  align-items: flex-start;
}
.canvas-card {
  flex: 1 1 640px;
  min-width: 320px;
}
canvas {
  width: 100%;
  height: auto; /* 保持宽高比，同时让 CSS 尺寸和内部尺寸不同 → 正好演示坐标换算 */
  background: #0b1220;
  border: 1px solid #1e293b;
  border-radius: 12px;
  cursor: grab;
  touch-action: none; /* 手机上让浏览器别抢走触摸事件（否则拖不动） */
  display: block;
}
canvas:active {
  cursor: grabbing;
}
.hint {
  font-size: 13px;
  color: #94a3b8;
  line-height: 1.8;
}
.legend {
  display: inline-block;
  margin-right: 12px;
}
.legend.local {
  color: #22c55e;
}
.legend.remote {
  color: #3b82f6;
}
.legend.init {
  color: #94a3b8;
}

.panel {
  flex: 1 1 300px;
  background: #0f172a;
  border: 1px solid #1e293b;
  border-radius: 12px;
  padding: 16px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
  padding: 5px 0;
  border-bottom: 1px dashed #1e293b;
}
.kv span {
  color: #94a3b8;
}
.kv b {
  color: #e2e8f0;
  font-family: ui-monospace, Consolas, monospace;
}
.kv b.small {
  font-size: 11px;
  word-break: break-all;
}
.panel h2 {
  font-size: 14px;
  margin: 16px 0 8px;
  color: #cbd5e1;
}
.logs {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 260px;
  overflow-y: auto;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 12px;
}
.logs li {
  padding: 4px 0;
  color: #cbd5e1;
  border-bottom: 1px solid #131e33;
  word-break: break-all;
}
.logs li.empty {
  color: #64748b;
}
</style>
