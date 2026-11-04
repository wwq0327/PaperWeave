import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// 生产构建使用严格 CSP：禁止网络连接、内联脚本、远程图片与子框架。
// 开发服务器需放行 Vite 的内联刷新脚本与 HMR WebSocket，仅限本机开发。
const cspBase = "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'";
function csp(): Plugin {
  return {
    name: "paperweave-csp",
    transformIndexHtml(html, context) {
      const script = context.server ? "'self' 'unsafe-inline'" : "'self'";
      const connect = context.server ? "'self' ws:" : "'none'";
      const policy = `${cspBase}; script-src ${script}; connect-src ${connect}`;
      return html.replace("</head>", `  <meta http-equiv="Content-Security-Policy" content="${policy}" />\n  </head>`);
    },
  };
}

// 渲染进程构建为静态资源，由主进程以 file:// 加载（base 必须为相对路径）。
// root 指到 src/renderer 后，必须把 outDir 显式拉回项目根的 .vite/renderer/main_window
// （插件默认 outDir 相对 root，不改会输出到 src/renderer/.vite/ 下）。
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react(), csp()],
  build: {
    outDir: "../../.vite/renderer/main_window",
    rollupOptions: {
      input: "index.html",
    },
  },
});
