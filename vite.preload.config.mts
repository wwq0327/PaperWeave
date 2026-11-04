import { defineConfig } from "vite";

// 预加载脚本由 @electron-forge/plugin-vite 构建为 .vite/build/preload.cjs。
// sandbox: true 的预加载必须是 CJS（Forge 已固定 output.format = "cjs"）。
export default defineConfig({});
