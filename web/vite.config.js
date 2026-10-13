import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

// vite.config.js 里 import.meta.url 指向本文件，借此算出项目根目录（web/ 的上一级）。
// shared/ 协议目录就在那里 —— 它是前后端共用的，不属于 web 也不属于 server。
const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  plugins: [vue()],
  server: {
    // host: true 等价于 --host，让 Vite 监听 0.0.0.0 而不是只监听 127.0.0.1。
    // 这一步是"用手机/另一台电脑打开页面"的前提：
    //   只监听 127.0.0.1 时，局域网里的其它设备根本连不上开发服务器。
    // 启动后终端会多打印几行 Network: http://192.168.x.x:5180  —— 手机就用这个地址。
    host: true,

    // 【为什么端口是 5180 而不是 Vite 默认的 5173？】
    // 这台电脑上已经有一个别的项目（家教系统）的 vite dev 跑在 5173 上了，
    // 结果是 localhost:5173 和 127.0.0.1:5173 会分别落到两个不同的项目上，非常容易搞混。
    // 所以这里固定用一个不冲突的端口。
    port: 5180,

    // strictPort: true = 端口被占用时直接报错，而不是"悄悄换一个端口继续跑"。
    // 对教学项目来说这很重要：端口是"悄悄变了"，你的浏览器地址却没变，
    // 打开的还是旧页面，你会以为是代码没生效，其实连的是另一个服务。
    strictPort: true,

    // 【为什么要配 fs.allow？】
    // 前端 useSyncSocket.js 会 import 项目根目录下的 ../shared/protocol.js，
    // 而 Vite 的"地盘"默认只到 web/。开发服务器出于安全考虑（server.fs.strict）
    // 默认不 serve 地盘外的文件，浏览器加载协议模块时会直接 403。
    // 把项目根目录整个加进白名单，shared/ 就能被正常加载了。
    // （生产构建走 Rollup，没有这个限制；但 dev 是日常姿势，必须能跑。）
    fs: {
      allow: [projectRoot],
    },
  },
});
