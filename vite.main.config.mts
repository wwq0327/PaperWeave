import { defineConfig } from "vite";

// 主进程构建由 @electron-forge/plugin-vite 提供默认值：
// entry 取自 forge.config.ts，输出 .vite/build/main.cjs（CJS），
// electron 与 node: 内置模块自动 external，渲染器全局常量自动注入。
export default defineConfig({});
