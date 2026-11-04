import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// 渲染进程构建为静态资源，由主进程以 file:// 加载（base 必须为相对路径）。
// root 指到 src/renderer 后，必须把 outDir 显式拉回项目根的 .vite/renderer/main_window
// （插件默认 outDir 相对 root，不改会输出到 src/renderer/.vite/ 下）。
export default defineConfig({
  root: "src/renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../../.vite/renderer/main_window",
    rollupOptions: {
      input: "index.html",
    },
  },
});
