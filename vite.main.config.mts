import { defineConfig } from "vite";

// 主进程构建由 @electron-forge/plugin-vite 提供默认值：
// entry 取自 forge.config.ts，输出 .vite/build/main.cjs（CJS），
// electron 和常用 node: 模块由插件处理，渲染器全局常量自动注入。
// node:sqlite 不在部分构建工具的内置模块清单中，必须保留给 Electron 的 Node 加载。
export default defineConfig({ build: { rollupOptions: { external: ["node:sqlite"] } } });
